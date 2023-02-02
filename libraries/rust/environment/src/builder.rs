use std::{any::Any, fmt::Debug, str::FromStr};

use spl_governance::state::{
    native_treasury::get_native_treasury_address,
    proposal_transaction::{AccountMetaData, InstructionData},
};
use thiserror::Error;

use solana_sdk::{instruction::Instruction, pubkey::Pubkey};

use jet_instructions::{
    control::ControlIxBuilder,
    margin::{derive_token_config, MarginConfigIxBuilder},
    test_service::{derive_token_mint, if_not_initialized},
};
use jet_margin::TokenConfig;
use jet_solana_client::{
    network::NetworkKind, transaction::TransactionBuilder, ExtError, NetworkUserInterface,
    NetworkUserInterfaceExt,
};

use crate::config::{EnvironmentConfig, TokenDescription};

pub(crate) mod fixed_term;
pub(crate) mod global;
pub(crate) mod margin;
pub(crate) mod margin_pool;
pub(crate) mod swap;

pub use global::configure_environment;
pub use swap::resolve_swap_program;

/// Descriptions for errors while building the configuration instructions
#[derive(Error, Debug)]
pub enum BuilderError {
    #[error("error using network interface: {0:?}")]
    InterfaceError(Box<dyn Any + Send + Sync>),

    #[error("missing pyth_price field for token {0}")]
    MissingPythPrice(String),

    #[error("missing pyth_product field for token {0}")]
    MissingPythProduct(String),

    #[error("missing mint field for token {0}")]
    MissingMint(String),

    #[error("missing decimals field for token {0}")]
    MissingDecimals(String),

    #[error("no definition for token {0}")]
    UnknownToken(String),

    #[error("unknown swap program '{0}'")]
    UnknownSwapProgram(String),

    #[error(
        "connected to the wrong network for the given config: {actual:?} (expected {expected:?})"
    )]
    WrongNetwork {
        expected: NetworkKind,
        actual: NetworkKind,
    },
}

impl<I: NetworkUserInterface> From<ExtError<I>> for BuilderError {
    fn from(err: ExtError<I>) -> Self {
        Self::InterfaceError(Box::new(err))
    }
}

pub trait AccountsRetriever {
    fn exists(&self, address: &Pubkey) -> bool;
}

#[derive(Debug)]
pub struct ProposalContext {
    pub program: Pubkey,
    pub proposal: Pubkey,
    pub option: u8,
    pub governance: Pubkey,
    pub proposal_owner_record: Pubkey,
    pub tx_next_index: u16,
}

#[derive(Debug)]
pub(crate) struct TokenContext {
    airspace: Pubkey,
    mint: Pubkey,
    pyth_price: Pubkey,
    pyth_product: Pubkey,
    oracle_authority: Pubkey,
    desc: TokenDescription,
}

pub struct PlanInstructions {
    pub setup: Vec<TransactionBuilder>,
    pub propose: Vec<TransactionBuilder>,
}

pub struct Builder<I> {
    pub(crate) authority: Pubkey,
    pub(crate) network: NetworkKind,
    pub(crate) interface: I,
    pub(crate) proposal_context: Option<ProposalContext>,
    setup_tx: Vec<TransactionBuilder>,
    propose_tx: Vec<TransactionBuilder>,
}

impl<I: NetworkUserInterface> Builder<I> {
    pub async fn new(network_interface: I, authority: Pubkey) -> Result<Self, BuilderError> {
        Ok(Self {
            authority,
            network: NetworkKind::from_interface(&network_interface)
                .await
                .map_err(|e| BuilderError::InterfaceError(Box::new(e)))?,
            interface: network_interface,
            proposal_context: None,
            setup_tx: vec![],
            propose_tx: vec![],
        })
    }

    pub fn build(self) -> PlanInstructions {
        PlanInstructions {
            setup: self.setup_tx,
            propose: self.propose_tx,
        }
    }

    pub fn set_proposal_context(&mut self, context: ProposalContext) {
        self.proposal_context = Some(context);
    }

    pub fn payer(&self) -> Pubkey {
        self.interface.signer()
    }

    pub fn proposal_payer(&self) -> Pubkey {
        match &self.proposal_context {
            None => self.payer(),
            Some(ctx) => get_native_treasury_address(&ctx.program, &ctx.governance),
        }
    }

    pub fn proposal_authority(&self) -> Pubkey {
        match &self.proposal_context {
            None => self.payer(),
            Some(ctx) => ctx.governance,
        }
    }

    pub async fn account_exists(&self, address: &Pubkey) -> Result<bool, BuilderError> {
        self.interface
            .account_exists(address)
            .await
            .map_err(|e| BuilderError::InterfaceError(Box::new(e)))
    }

    pub async fn get_margin_token_configs(
        &self,
        airspace: &Pubkey,
        tokens: &[Pubkey],
    ) -> Result<Vec<Option<TokenConfig>>, BuilderError> {
        let addresses = tokens
            .iter()
            .map(|addr| derive_token_config(airspace, addr))
            .collect::<Vec<_>>();

        Ok(self.interface.get_anchor_accounts(&addresses).await?)
    }

    pub fn setup<T: Into<TransactionBuilder>>(&mut self, txns: impl IntoIterator<Item = T>) {
        self.setup_tx.extend(txns.into_iter().map(|t| t.into()))
    }

    pub fn propose(&mut self, instructions: impl IntoIterator<Item = Instruction>) {
        let payer = self.payer();

        let instructions = match &mut self.proposal_context {
            None => instructions
                .into_iter()
                .map(TransactionBuilder::from)
                .collect::<Vec<_>>(),
            Some(ctx) => instructions
                .into_iter()
                .map(|ix| {
                    let accounts = ix
                        .accounts
                        .iter()
                        .map(|a| AccountMetaData {
                            pubkey: a.pubkey,
                            is_signer: a.is_signer,
                            is_writable: a.is_writable,
                        })
                        .collect::<Vec<_>>();

                    let ix_data = InstructionData {
                        accounts,
                        data: ix.data,
                        program_id: ix.program_id,
                    };

                    let add_ix = spl_governance::instruction::insert_transaction(
                        &ctx.program,
                        &ctx.governance,
                        &ctx.proposal,
                        &ctx.proposal_owner_record,
                        &payer,
                        &payer,
                        ctx.option,
                        ctx.tx_next_index,
                        0,
                        vec![ix_data],
                    );

                    ctx.tx_next_index += 1;
                    TransactionBuilder::from(add_ix)
                })
                .collect::<Vec<_>>(),
        };

        self.propose_tx.extend(instructions);
    }

    pub(crate) fn margin_config_ix(&self, airspace: &Pubkey) -> MarginConfigIxBuilder {
        MarginConfigIxBuilder::new(
            *airspace,
            self.proposal_payer(),
            Some(self.proposal_authority()),
        )
        .with_authority(self.proposal_authority())
    }

    pub(crate) fn control_ix(&self) -> ControlIxBuilder {
        ControlIxBuilder::new_for_authority(self.proposal_authority(), self.proposal_payer())
    }
}

pub(crate) async fn filter_initializers<I: NetworkUserInterface>(
    builder: &Builder<I>,
    ixns: impl IntoIterator<Item = (Pubkey, Instruction)>,
) -> Result<Vec<Instruction>, BuilderError> {
    let (accounts, ixns): (Vec<_>, Vec<_>) = ixns.into_iter().unzip();
    let exists = builder
        .interface
        .accounts_exist(&accounts)
        .await
        .map_err(|e| BuilderError::InterfaceError(Box::new(e)))?;

    Ok(ixns
        .into_iter()
        .enumerate()
        .filter_map(|(idx, ix)| {
            let ix = match builder.network {
                NetworkKind::Localnet => if_not_initialized(accounts[idx], ix),
                _ => ix,
            };

            (!exists[idx]).then_some(ix)
        })
        .collect())
}

pub(crate) fn resolve_token_mint(
    env: &EnvironmentConfig,
    name: &str,
) -> Result<Pubkey, BuilderError> {
    if let Ok(address) = Pubkey::from_str(name) {
        return Ok(address);
    }

    for airspace in &env.airspaces {
        for token in &airspace.tokens {
            if token.name != name {
                continue;
            }

            match token.mint {
                Some(mint) => return Ok(mint),
                None => return Ok(derive_token_mint(name)),
            }
        }
    }

    Err(BuilderError::UnknownToken(name.to_owned()))
}