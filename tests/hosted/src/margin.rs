// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Copyright (C) 2022 JET PROTOCOL HOLDINGS, LLC.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

#![allow(unused)]

use std::collections::HashMap;
use std::sync::Arc;

use anchor_lang::{
    AccountDeserialize, AccountSerialize, AnchorDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::associated_token::get_associated_token_address;
use anyhow::{bail, Error};

use jet_instructions::margin_swap::MarginSwapRouteIxBuilder;
use jet_margin::{AccountPosition, MarginAccount, TokenConfigUpdate, TokenKind};
use jet_margin_sdk::ix_builder::test_service::if_not_initialized;
use jet_margin_sdk::ix_builder::{
    derive_airspace, derive_margin_permit, derive_permit, get_control_authority_address,
    get_metadata_address, AirspaceIxBuilder, ControlIxBuilder, MarginConfigIxBuilder,
    MarginPoolConfiguration, MarginPoolIxBuilder,
};
use jet_margin_sdk::lookup_tables::LookupTable;
use jet_margin_sdk::refresh::canonical_position_refresher;
use jet_margin_sdk::refresh::position_refresher::{PositionRefresher, SmartRefresher};
use jet_margin_sdk::solana::keypair::{clone, KeypairExt};
use jet_margin_sdk::solana::transaction::{
    InverseSendTransactionBuilder, SendTransactionBuilder, TransactionBuilder,
    TransactionBuilderExt, WithSigner,
};
use jet_margin_sdk::swap::spl_swap::SplSwapPool;
use jet_margin_sdk::tokens::TokenOracle;
use jet_solana_client::rpc::AccountFilter;
use jet_solana_client::signature::Authorization;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::{Keypair, Signature, Signer};
use solana_sdk::system_program;
use solana_sdk::{pubkey::Pubkey, transaction::Transaction};

use jet_control::TokenMetadataParams;
use jet_margin_pool::{Amount, MarginPool, MarginPoolConfig, TokenChange};
use jet_margin_sdk::tx_builder::{
    global_initialize_instructions, AirspaceAdmin, MarginActionAuthority, MarginInvokeContext,
    MarginTxBuilder, TokenDepositsConfig,
};
use jet_metadata::{LiquidatorMetadata, MarginAdapterMetadata, TokenMetadata};
use jet_simulation::{send_and_confirm, solana_rpc_api::SolanaRpcClient};

/// Information needed to create a new margin pool
pub struct MarginPoolSetupInfo {
    pub token: Pubkey,
    pub token_kind: TokenKind,
    pub collateral_weight: u16,
    pub max_leverage: u16,
    pub oracle: TokenOracle,
    pub config: MarginPoolConfig,
}

/// Utility for making use of the Jet margin system.
pub struct MarginClient {
    rpc: Arc<dyn SolanaRpcClient>,
    tx_admin: AirspaceAdmin,
    airspace: AirspaceIxBuilder,
    airspace_authority: Keypair,
}

impl MarginClient {
    pub fn new(
        rpc: Arc<dyn SolanaRpcClient>,
        airspace_seed: &str,
        airspace_authority: Option<Keypair>,
    ) -> Self {
        let payer = rpc.payer().pubkey();
        let airspace_authority = airspace_authority.unwrap_or_else(|| clone(rpc.payer()));

        Self {
            tx_admin: AirspaceAdmin::new(airspace_seed, payer, airspace_authority.pubkey()),
            airspace: AirspaceIxBuilder::new(airspace_seed, payer, payer),
            rpc,
            airspace_authority,
        }
    }

    pub fn user(&self, keypair: &Keypair, seed: u16) -> MarginUser {
        let tx = MarginTxBuilder::new(
            self.rpc.clone(),
            Some(clone(keypair)),
            keypair.pubkey(),
            seed,
            self.tx_admin.airspace(),
        );

        MarginUser {
            signer: clone(keypair),
            rpc: self.rpc.clone(),
            refresher: canonical_position_refresher(self.rpc.clone()).for_address(*tx.address()),
            tx,
        }
    }

    pub fn airspace(&self) -> Pubkey {
        self.airspace.address()
    }

    pub fn liquidator(
        &self,
        keypair: &Keypair,
        owner: &Pubkey,
        seed: u16,
    ) -> Result<MarginUser, Error> {
        let tx = MarginTxBuilder::new_liquidator(
            self.rpc.clone(),
            Keypair::from_bytes(&keypair.to_bytes())?,
            self.airspace(),
            *owner,
            seed,
        );

        Ok(MarginUser {
            signer: clone(keypair),
            rpc: self.rpc.clone(),
            refresher: canonical_position_refresher(self.rpc.clone()).for_address(*tx.address()),
            tx,
        })
    }

    /// Find all the margin pools created
    pub async fn find_pools(&self) -> Result<Vec<MarginPool>, Error> {
        self.rpc
            .get_program_accounts(
                &jet_margin_pool::ID,
                vec![AccountFilter::DataSize(std::mem::size_of::<MarginPool>())],
            )
            .await?
            .into_iter()
            .map(|(_, account)| {
                MarginPool::try_deserialize(&mut &account.data[..]).map_err(Error::from)
            })
            .collect()
    }

    pub async fn get_pool(&self, token: &Pubkey) -> Result<MarginPool, Error> {
        let pool_builder = MarginPoolIxBuilder::new(*token);
        let account = self.rpc.get_account(&pool_builder.address).await?;

        if account.is_none() {
            bail!("could not find pool");
        }

        MarginPool::try_deserialize(&mut &account.unwrap().data[..]).map_err(Error::from)
    }

    pub async fn create_airspace_if_missing(&self, is_restricted: bool) -> Result<(), Error> {
        let airspace = derive_airspace("default");

        if self.rpc.get_account(&airspace).await?.is_none() {
            self.create_airspace(is_restricted).await?;
        }

        Ok(())
    }

    pub async fn init_globals(&self) -> Result<(), Error> {
        self.rpc
            .send_and_confirm_condensed(global_initialize_instructions(self.rpc.payer().pubkey()))
            .await?;

        Ok(())
    }

    pub async fn create_airspace(&self, is_restricted: bool) -> Result<(), Error> {
        let tx: TransactionBuilder = self.create_airspace_ix(is_restricted).into();
        self.rpc.send_and_confirm(tx).await?;
        Ok(())
    }

    pub fn create_airspace_ix(&self, is_restricted: bool) -> Instruction {
        if_not_initialized(
            self.airspace.address(),
            self.airspace
                .create(self.airspace_authority.pubkey(), is_restricted),
        )
    }

    pub async fn create_authority_if_missing(&self) -> Result<(), Error> {
        if self
            .rpc
            .get_account(&get_control_authority_address())
            .await?
            .is_none()
        {
            self.create_authority().await?;
        }

        Ok(())
    }

    pub async fn create_authority(&self) -> Result<(), Error> {
        let ix = ControlIxBuilder::new(self.rpc.payer().pubkey()).create_authority();

        send_and_confirm(&self.rpc, &[ix], &[]).await?;
        Ok(())
    }

    pub async fn register_adapter_if_unregistered(&self, adapter: &Pubkey) -> Result<(), Error> {
        if self
            .rpc
            .get_account(&get_metadata_address(adapter))
            .await?
            .is_none()
        {
            self.register_adapter(adapter).await?;
        }

        Ok(())
    }

    pub async fn register_adapter(&self, adapter: &Pubkey) -> Result<(), Error> {
        self.tx_admin
            .configure_margin_adapter(*adapter, true)
            .with_signer(&self.airspace_authority)
            .send_and_confirm(&self.rpc)
            .await?;
        Ok(())
    }

    /// Configure deposits for a given token (when placed directly into a margin account)
    pub async fn configure_token_deposits(
        &self,
        underlying_mint: &Pubkey,
        config: Option<&TokenDepositsConfig>,
    ) -> Result<(), Error> {
        self.tx_admin
            .configure_margin_token_deposits(*underlying_mint, config.cloned())
            .with_signer(&self.airspace_authority)
            .send_and_confirm(&self.rpc)
            .await?;
        Ok(())
    }

    pub async fn configure_margin_pool(
        &self,
        token: &Pubkey,
        config: &MarginPoolConfiguration,
    ) -> Result<(), Error> {
        self.tx_admin
            .configure_margin_pool(*token, config)
            .with_signer(&self.airspace_authority)
            .send_and_confirm(&self.rpc)
            .await?;
        Ok(())
    }

    /// Create a new margin pool for a token
    pub async fn create_pool(&self, setup_info: &MarginPoolSetupInfo) -> Result<(), Error> {
        self.tx_admin
            .create_margin_pool(setup_info.token)
            .with_signer(&self.airspace_authority)
            .send_and_confirm(&self.rpc)
            .await?;

        self.tx_admin
            .configure_margin_pool(
                setup_info.token,
                &MarginPoolConfiguration {
                    pyth_price: Some(setup_info.oracle.price),
                    pyth_product: Some(setup_info.oracle.product),
                    metadata: Some(TokenMetadataParams {
                        token_kind: jet_metadata::TokenKind::Collateral,
                        collateral_weight: setup_info.collateral_weight,
                        max_leverage: setup_info.max_leverage,
                    }),
                    parameters: Some(setup_info.config),
                },
            )
            .with_signer(&self.airspace_authority)
            .send_and_confirm(&self.rpc)
            .await?;

        Ok(())
    }

    pub async fn set_liquidator_metadata(
        &self,
        liquidator: Pubkey,
        is_liquidator: bool,
    ) -> Result<(), Error> {
        let margin_ix = MarginConfigIxBuilder::new(
            self.tx_admin.airspace(),
            self.rpc.payer().pubkey(),
            Some(self.airspace_authority.pubkey()),
        )
        .configure_liquidator(liquidator, is_liquidator);

        send_and_confirm(&self.rpc, &[margin_ix], &[&self.airspace_authority]).await?;

        Ok(())
    }

    pub async fn get_account(&self, address: &Pubkey) -> Result<Box<MarginAccount>, Error> {
        let account_data = self.rpc.get_account(address).await?;

        match account_data {
            None => bail!("no margin account found {}", address),
            Some(account) => Ok(Box::new(MarginAccount::try_deserialize(
                &mut &account.data[..],
            )?)),
        }
    }
}

pub struct MarginUser {
    pub tx: MarginTxBuilder,
    pub signer: Keypair,
    pub refresher: SmartRefresher<Pubkey>,
    rpc: Arc<dyn SolanaRpcClient>,
}

impl Clone for MarginUser {
    fn clone(&self) -> Self {
        Self {
            tx: self.tx.clone(),
            signer: clone(&self.signer),
            rpc: self.rpc.clone(),
            refresher: canonical_position_refresher(self.rpc.clone())
                .for_address(*self.tx.address()),
        }
    }
}

impl std::fmt::Debug for MarginUser {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MarginUser")
            // .field("tx", &self.tx)
            // .field("rpc", &self.rpc)
            .finish()
    }
}

impl MarginUser {
    pub async fn print(&self) {
        println!("{:#?}", self.tx.get_account_state().await.unwrap())
    }

    async fn send_confirm_tx(&self, tx: Transaction) -> Result<(), Error> {
        self.rpc.send_and_confirm_transaction(&tx).await?;
        Ok(())
    }

    async fn send_confirm_all_tx(
        &self,
        transactions: impl IntoIterator<Item = Transaction>,
    ) -> Result<(), Error> {
        futures::future::join_all(transactions.into_iter().map(|tx| self.send_confirm_tx(tx)))
            .await
            .into_iter()
            .collect()
    }

    /// Creates a new Self for actions on the same margin account, but
    /// authorized by provided liquidator.
    pub fn liquidator(&self, liquidator: Keypair) -> Self {
        Self {
            signer: clone(&liquidator),
            tx: self.tx.liquidator(liquidator),
            rpc: self.rpc.clone(),
            refresher: canonical_position_refresher(self.rpc.clone())
                .for_address(*self.tx.address()),
        }
    }

    pub fn owner(&self) -> &Pubkey {
        self.tx.owner()
    }

    pub fn auth(&self) -> Authorization {
        Authorization {
            address: *self.address(),
            authority: self.signer.clone(),
        }
    }

    pub fn ctx(&self) -> MarginInvokeContext {
        MarginInvokeContext {
            margin_account: *self.address(),
            authority: self.signer.pubkey(),
            airspace: self.tx.airspace(),
            is_liquidator: self.tx.is_liquidator(),
        }
    }

    pub fn signer(&self) -> Pubkey {
        self.tx.signer()
    }

    pub fn address(&self) -> &Pubkey {
        self.tx.address()
    }

    pub fn seed(&self) -> u16 {
        self.tx.seed()
    }

    pub async fn create_account(&self) -> Result<(), Error> {
        self.send_confirm_tx(self.tx.create_account().await?).await
    }

    pub async fn created(self) -> Result<Self, Error> {
        self.create_account().await?;
        Ok(self)
    }

    /// Close the margin account
    ///
    /// # Error
    ///
    /// Returns an error if the account is not empty, in which case positions
    /// should be closed first.
    pub async fn close_account(&self) -> Result<(), Error> {
        self.send_confirm_tx(self.tx.close_account().await?).await
    }

    /// Create an address lookup registry account
    pub async fn init_lookup_registry(&self) -> Result<(), Error> {
        self.send_confirm_tx(self.tx.init_lookup_registry().await?)
            .await
    }

    /// Create a lookup table in a lookup registry account
    ///
    /// TODO: might be useful to return the address created to the caller
    pub async fn create_lookup_table(&self) -> Result<Pubkey, Error> {
        let (tx, lookup_table) = self.tx.create_lookup_table().await?;
        self.send_confirm_tx(tx).await?;

        Ok(lookup_table)
    }

    /// Append accounts into a lookup table
    pub async fn append_to_lookup_table(
        &self,
        lookup_table: Pubkey,
        addresses: &[Pubkey],
    ) -> Result<(), Error> {
        self.send_confirm_tx(
            self.tx
                .append_to_lookup_table(lookup_table, addresses)
                .await?,
        )
        .await
    }

    pub async fn refresh_pool_position(&self, token_mint: &Pubkey) -> Result<(), Error> {
        self.tx
            .refresh_pool_position(token_mint)
            .await?
            .without_signer()
            .send_and_confirm(&self.rpc)
            .await?;
        Ok(())
    }

    pub async fn refresh_all_pool_positions(&self) -> Result<Vec<Signature>, Error> {
        self.rpc
            .send_and_confirm_condensed(self.tx.refresh_all_pool_positions().await?)
            .await
    }

    pub async fn refresh_positions(&self) -> Result<Vec<Signature>, Error> {
        self.refresher
            .refresh_positions(&())
            .await?
            .send_and_confirm_condensed(&self.rpc)
            .await
    }

    pub async fn refresh_all_position_metadata(&self, refresher: &Keypair) -> Result<(), Error> {
        self.tx
            .clone()
            .with_signer(clone(refresher))
            .refresh_all_position_metadata()
            .await?
            .send_and_confirm_condensed(&self.rpc)
            .await
            .map(|_| ())
    }

    pub async fn pool_deposit(
        &self,
        underlying_mint: &Pubkey,
        source: Option<Pubkey>,
        change: TokenChange,
        source_authority: MarginActionAuthority,
    ) -> Result<(), Error> {
        self.tx
            .pool_deposit(underlying_mint, source, change, source_authority)
            .await?
            .send_and_confirm(&self.rpc)
            .await?;

        Ok(())
    }

    /// do not add any new usages of this function.  
    /// todo: replace existing usages with `pool_deposit`
    pub async fn pool_deposit_deprecated(
        &self,
        mint: &Pubkey,
        source: &Pubkey,
        change: TokenChange,
    ) -> Result<(), Error> {
        self.tx
            .pool_deposit_deprecated(
                mint,
                Some(*source),
                change,
                MarginActionAuthority::AccountAuthority,
            )
            .await?
            .send_and_confirm(&self.rpc)
            .await?;

        Ok(())
    }

    pub async fn withdraw(
        &self,
        mint: &Pubkey,
        destination: &Pubkey,
        change: TokenChange,
    ) -> Result<(), Error> {
        self.send_confirm_tx(self.tx.withdraw(mint, destination, change).await?)
            .await
    }

    pub async fn borrow(&self, mint: &Pubkey, change: TokenChange) -> Result<Signature, Error> {
        self.rpc
            .send_and_confirm(self.tx.borrow(mint, change).await?)
            .await
    }

    pub async fn margin_repay(&self, mint: &Pubkey, change: TokenChange) -> Result<(), Error> {
        self.rpc
            .send_and_confirm(self.tx.margin_repay(mint, change).await?)
            .await
            .map(|_| ())
    }

    // todo this is a leaky abstraction because it allows a source to be
    // specified without allowing the caller to specify the authority. may be
    // better to expose the authority as well.
    pub async fn repay(
        &self,
        mint: &Pubkey,
        source: &Pubkey,
        change: TokenChange,
    ) -> Result<(), Error> {
        self.tx
            .pool_repay(
                *mint,
                Some(*source),
                change,
                MarginActionAuthority::AccountAuthority,
            )
            .send_and_confirm(&self.rpc)
            .await?;
        Ok(())
    }

    /// Swap between two tokens using a swap pool.
    ///
    /// The `source_mint` and `destination_mint` determine the direction of
    /// the swap.
    #[allow(clippy::too_many_arguments)]
    pub async fn swap(
        &self,
        program_id: &Pubkey,
        source_mint: &Pubkey,
        destination_mint: &Pubkey,
        swap_pool: &SplSwapPool,
        change: TokenChange,
        minimum_amount_out: u64,
    ) -> Result<(), Error> {
        // Determine the order of token_a and token_b based on direction of swap
        let (source_token, destination_token) = if source_mint == &swap_pool.mint_a {
            (&swap_pool.token_a, &swap_pool.token_b)
        } else {
            (&swap_pool.token_b, &swap_pool.token_a)
        };
        self.rpc
            .send_and_confirm_condensed_in_order(
                self.tx
                    .swap(
                        source_mint,
                        destination_mint,
                        &swap_pool.pool,
                        &swap_pool.pool_mint,
                        &swap_pool.fee_account,
                        source_token,
                        destination_token,
                        program_id,
                        change,
                        minimum_amount_out,
                    )
                    .await?,
            )
            .await
            .map(|_| ())
    }

    /// Execute a swap route
    pub async fn route_swap(
        &self,
        builder: &MarginSwapRouteIxBuilder,
        account_lookup_tables: &[Pubkey],
    ) -> Result<(), Error> {
        // If there are lookup tables, use them
        if account_lookup_tables.is_empty() {
            self.rpc
                .send_and_confirm_condensed_in_order(self.tx.route_swap(builder).await?)
                .await?;
        } else {
            let versioned_tx = self
                .tx
                .route_swap_with_lookup(builder, account_lookup_tables, &self.signer)
                .await?;
            self.rpc.send_versioned_transaction(&versioned_tx).await?;
        }
        Ok(())
    }

    /// Create OpenBook open orders account
    pub async fn create_openbook_open_orders(
        &self,
        market: &Pubkey,
        program: &Pubkey,
    ) -> Result<(), Error> {
        let tx = self.tx.create_openbook_open_orders(market, program);
        self.rpc.send_and_confirm(tx).await?;
        Ok(())
    }

    /// Close OpenBook open orders account
    pub async fn close_openbook_open_orders(
        &self,
        market: &Pubkey,
        program: &Pubkey,
    ) -> Result<(), Error> {
        let tx = self.tx.close_openbook_open_orders(market, program);
        self.rpc.send_and_confirm(tx).await?;
        Ok(())
    }

    pub async fn positions(&self) -> Result<Vec<AccountPosition>, Error> {
        Ok(self
            .tx
            .get_account_state()
            .await?
            .positions()
            .copied()
            .collect())
    }

    pub async fn liquidate_begin(&self, refresh_positions: bool) -> Result<(), Error> {
        self.send_confirm_tx(self.tx.liquidate_begin(refresh_positions).await?)
            .await
    }

    pub async fn liquidate_begin_tx(
        &self,
        refresh_positions: bool,
    ) -> Result<TransactionBuilder, Error> {
        self.tx.liquidate_begin_builder(refresh_positions).await
    }

    pub async fn liquidate_end(&self, original_liquidator: Option<Pubkey>) -> Result<(), Error> {
        self.send_confirm_tx(self.tx.liquidate_end(original_liquidator).await?)
            .await
    }

    pub async fn verify_healthy(&self) -> Result<(), Error> {
        self.send_confirm_tx(self.tx.verify_healthy().await?).await
    }

    pub async fn verify_unhealthy(&self) -> Result<(), Error> {
        self.send_confirm_tx(self.tx.verify_unhealthy().await?)
            .await
    }

    /// Close a user's empty positions.
    pub async fn close_empty_positions(
        &self,
        loan_to_token: &HashMap<Pubkey, Pubkey>,
    ) -> Result<(), Error> {
        self.rpc
            .send_and_confirm(self.tx.close_empty_positions(loan_to_token).await?)
            .await
            .map(|_| ())
    }

    /// Close a user's lending pool positions for a specific mint.
    pub async fn close_pool_positions(&self, token_mint: &Pubkey) -> Result<(), Error> {
        self.send_confirm_tx(self.tx.close_pool_positions(token_mint).await?)
            .await
    }

    /// Close a user's lending pool position for a mint, with the specified and token kind.
    pub async fn close_pool_position(
        &self,
        token_mint: &Pubkey,
        kind: TokenKind,
    ) -> Result<(), Error> {
        self.send_confirm_tx(self.tx.close_pool_position(token_mint, kind).await?)
            .await
    }

    /// Create a new token account attached to the margin account
    pub async fn create_deposit_position(&self, token_mint: &Pubkey) -> Result<Pubkey, Error> {
        self.send_confirm_tx(self.tx.create_deposit_position(token_mint).await?)
            .await?;

        Ok(get_associated_token_address(self.address(), token_mint))
    }

    /// Close a previously created deposit position
    pub async fn close_deposit_position(&self, token_mint: &Pubkey) -> Result<(), Error> {
        self.send_confirm_tx(self.tx.close_deposit_position(token_mint).await?)
            .await
    }

    /// Move funds in/out deposit account
    pub async fn transfer_deposit(
        &self,
        mint: &Pubkey,
        source_owner: &Pubkey,
        source: &Pubkey,
        destination: &Pubkey,
        amount: u64,
    ) -> Result<(), Error> {
        self.tx
            .transfer_deposit(*mint, *source_owner, *source, *destination, amount)
            .await?
            .send_and_confirm(&self.rpc)
            .await?;

        Ok(())
    }
}
