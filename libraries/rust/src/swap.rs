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

//! The margin swap module allows creating simulated swap pools
//! to aid in testing margin swaps.

use std::{collections::HashMap, sync::Arc};

use crate::tokens::TokenPrice;
use anchor_lang::AccountDeserialize;
use anchor_spl::token::spl_token::state::Mint;
use anyhow::Result;
use jet_proto_math::Number128;
use jet_simulation::solana_rpc_api::SolanaRpcClient;
use parking_lot::RwLock;
use pyth_sdk_solana::PriceFeed;
use solana_sdk::{program_pack::Pack, pubkey::Pubkey};
use spl_token_swap::state::SwapV1;
use tracing::*;

pub type PriceCache = Arc<RwLock<HashMap<Pubkey, PriceFeed>>>;

/// Addresses of an [`spl_token_swap`] compatible swap pool, required when using
/// [`jet_margin_swap`].
///
/// Supported pools are:
/// * spl_token_swap
/// * orca_v1
/// * orca_v2
#[derive(Debug, Clone, Copy)]
pub struct SwapPool {
    /// The address of the swap pool
    pub pool: Pubkey,
    /// The PDA of the pool authority, derived using the pool address and a nonce
    pub pool_authority: Pubkey,
    /// The mint of pool tokens that are minted when users supply pool liquidity
    pub pool_mint: Pubkey,
    /// The SPL token mint of one side of the pool
    pub mint_a: Pubkey,
    /// The SPL token mint of one side of the pool
    pub mint_b: Pubkey,
    /// The SPL token account that tokens are deposited into
    pub token_a: Pubkey,
    /// The SPL token account that tokens are deposited into
    pub token_b: Pubkey,
    /// The account that collects fees from the pool
    pub fee_account: Pubkey,
    /// The program of the pool, to distinguish between various supported pools
    pub program: Pubkey,
}

impl SwapPool {
    /// Get all swap pools that contain pairs of supported mints
    pub async fn get_pools(
        rpc: &Arc<dyn SolanaRpcClient>,
        supported_mints: &HashMap<Pubkey, Mint>,
        swap_program: Pubkey,
        price_cache: PriceCache,
    ) -> anyhow::Result<HashMap<(Pubkey, Pubkey), Self>> {
        let size = SwapV1::LEN + 1;
        let accounts = rpc
            .get_program_accounts(&swap_program, Some(size))
            .await
            .unwrap();

        let mut pool_sizes = HashMap::with_capacity(accounts.len());
        for (swap_address, pool_account) in accounts {
            let swap = SwapV1::unpack(&pool_account.data[1..]);
            let swap = match swap {
                Ok(swap) => swap,
                Err(_) => continue,
            };
            let (mint_a, mint_b) = match (
                supported_mints.get(&swap.token_a_mint),
                supported_mints.get(&swap.token_b_mint),
            ) {
                (Some(a), Some(b)) => (a, b),
                _ => continue,
            };

            info!(
                "Pool address: {swap_address}, token A {}, token B {}",
                swap.token_a_mint, swap.token_b_mint
            );

            // Determine the pool size, so we can use only the largest pools
            let (price_a, price_b) = {
                let reader = price_cache.read();
                let price_a = match reader.get(&swap.token_a_mint) {
                    Some(val) => val,
                    None => continue,
                };
                let token_price = price_feed_to_token_price(price_a);
                let price_a = Number128::from_decimal(token_price.price, token_price.exponent);
                let price_b = match reader.get(&swap.token_b_mint) {
                    Some(val) => val,
                    None => continue,
                };
                let token_price = price_feed_to_token_price(price_b);
                let price_b = Number128::from_decimal(token_price.price, token_price.exponent);
                (price_a, price_b)
            };

            // Get the token balances of both sides
            let token_a = match find_token(rpc, &swap.token_a).await {
                Ok(val) => val,
                Err(_) => {
                    warn!("Unable to get token account {} for swap pool {swap_address}, excluding pool", swap.token_a);
                    continue;
                }
            };
            let token_b = match find_token(rpc, &swap.token_b).await {
                Ok(val) => val,
                Err(_) => {
                    warn!("Unable to get token account {} for swap pool {swap_address}, excluding pool", swap.token_b);
                    continue;
                }
            };
            let token_a_balance =
                Number128::from_decimal(token_a.amount, -(mint_a.decimals as i32));
            let token_b_balance =
                Number128::from_decimal(token_b.amount, -(mint_b.decimals as i32));

            let token_a_value = token_a_balance * price_a;
            let token_b_value = token_b_balance * price_b;
            // TODO: it'd be interesting to check the skewness of pools at this point
            let total_value = token_a_value + token_b_value;

            // If the value is smaller than a low threshold, ignore
            if total_value < Number128::from_decimal(10_000, 0) {
                warn!("Pool {swap_address} has {total_value}, which is less than threshold of $10'000, ignoring");
                continue;
            }
            info!("Pool {swap_address} has {total_value}, added as a candidate for inclusion");

            // Check if there is a pool, insert if none, replace if smaller
            pool_sizes
                .entry((swap.token_a_mint, swap.token_b_mint))
                .and_modify(|(e_pool, e_value)| {
                    if &total_value > e_value {
                        // Replace with current pool
                        *e_pool = Self::from_swap_v1(swap_address, swap_program, &swap);
                        *e_value = total_value;
                    }
                })
                .or_insert((
                    Self::from_swap_v1(swap_address, swap_program, &swap),
                    total_value,
                ));
        }
        // Discard amounts
        let swap_pools = pool_sizes
            .into_iter()
            .map(|(k, (p, _))| (k, p))
            .collect::<HashMap<_, _>>();
        info!("There are {} spl token swap pools found", swap_pools.len());

        Ok(swap_pools)
    }

    #[inline]
    /// Little helper to get a [SwapPool] from its on-chain rep
    fn from_swap_v1(swap_address: Pubkey, swap_program: Pubkey, swap: &SwapV1) -> SwapPool {
        SwapPool {
            pool: swap_address,
            pool_authority: Pubkey::find_program_address(
                &[swap_address.as_ref(), &[swap.nonce]],
                &swap_program,
            )
            .0,
            mint_a: swap.token_a_mint,
            mint_b: swap.token_b_mint,
            token_a: swap.token_a,
            token_b: swap.token_b,
            fee_account: swap.pool_fee_account,
            pool_mint: swap.pool_mint,
            program: swap_program,
        }
    }
}

// helper function to find token account
async fn find_token(
    rpc: &Arc<dyn SolanaRpcClient>,
    address: &Pubkey,
) -> Result<anchor_spl::token::TokenAccount> {
    let account = rpc.get_account(address).await?.unwrap();
    let data = &mut &account.data[..];
    let account = anchor_spl::token::TokenAccount::try_deserialize_unchecked(data)?;

    Ok(account)
}

// helper function to find the token price based on pyth price feed
fn price_feed_to_token_price(price: &PriceFeed) -> TokenPrice {
    let current_price = price.get_current_price().unwrap();
    TokenPrice {
        exponent: price.expo,
        price: current_price.price,
        confidence: current_price.conf,
        twap: price.get_ema_price().unwrap().price as u64,
    }
}