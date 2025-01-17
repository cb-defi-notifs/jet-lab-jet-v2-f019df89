use std::{collections::BTreeMap, fmt::Debug, str::FromStr, sync::Arc};

use spl_governance::state::{
    native_treasury::get_native_treasury_address,
    proposal_transaction::{AccountMetaData, InstructionData},
};
use thiserror::Error;

use solana_sdk::{instruction::Instruction, pubkey::Pubkey, signer::Signer};

use jet_instructions::{
    control::ControlIxBuilder,
    margin::{derive_token_config, MarginConfigIxBuilder},
    test_service::{derive_token_mint, if_not_initialized},
};
use jet_margin::TokenConfig;
use jet_solana_client::{
    network::NetworkKind,
    rpc::{ClientError, SolanaRpc, SolanaRpcExtra},
    transaction::TransactionBuilder,
};

use crate::config::{EnvironmentConfig, TokenDescription};

pub(crate) mod fixed_term;
pub(crate) mod global;
pub(crate) mod margin;
pub(crate) mod margin_pool;
pub(crate) mod swap;

pub use fixed_term::configure_market_for_token;
pub use global::{configure_environment, configure_tokens, create_test_tokens, token_context};
pub use swap::{resolve_swap_program, DEFAULT_TICK_SPACING as WHIRLPOOL_TICK_SPACING};

/// Descriptions for errors while building the configuration instructions
/// - TODO: It would be great to find a way to make this Sync + Send, but it's
///   not straightforward due to the wasm error not being Sync or Send, which
///   needs to go into InterfaceError.
#[derive(Error, Debug)]
pub enum BuilderError {
    #[error("error using network interface: {0:?}")]
    ClientError(#[from] ClientError),

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

pub trait AccountsRetriever {
    fn exists(&self, address: &Pubkey) -> bool;
}

/// How will the proposed instructions be executed?
pub enum ProposalExecution {
    /// by creating a governance proposal. The actual instructions will be
    /// executed later.
    Governance(ProposalContext),

    /// by directly submitting a transaction that contains the instructions.
    Direct {
        /// The account that invoked programs may expect to sign the proposed
        /// instructions. You are expected to own this keypair, so you can
        /// directly sign the transactions with it.
        authority: Pubkey,
    },
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
pub struct TokenContext {
    airspace: Pubkey,
    mint: Pubkey,
    pyth_price: Pubkey,
    pyth_product: Pubkey,
    oracle_authority: Pubkey,
    desc: TokenDescription, // TODO: is this whole thing really needed?
}

pub struct PlanInstructions {
    pub setup: Vec<Vec<TransactionBuilder>>,
    pub propose: Vec<TransactionBuilder>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Ord, PartialOrd)]
pub enum SetupPhase {
    TokenMints,
    TokenAccounts,
    Swaps,
}

pub struct Builder {
    pub(crate) network: NetworkKind,
    pub(crate) interface: Arc<dyn SolanaRpc>,
    pub(crate) signer: Arc<dyn Signer>,
    pub(crate) proposal_execution: ProposalExecution,
    setup_tx: BTreeMap<SetupPhase, Vec<TransactionBuilder>>,
    propose_tx: Vec<TransactionBuilder>,
}

impl Builder {
    pub async fn new(
        interface: Arc<dyn SolanaRpc>,
        signer: Arc<dyn Signer>,
        proposal_execution: ProposalExecution,
    ) -> Result<Self, BuilderError> {
        Ok(Self {
            network: NetworkKind::from_interface(interface.as_ref()).await?,
            interface,
            proposal_execution,
            setup_tx: BTreeMap::new(),
            propose_tx: vec![],
            signer,
        })
    }

    /// Variant of the normal constructor, with three differences:  
    /// ✓ never need to be awaited  
    /// ✓ never returns an error  
    /// 🗴 NetworkKind must be known in advance  
    pub fn new_infallible(
        interface: Arc<dyn SolanaRpc>,
        signer: Arc<dyn Signer>,
        proposal_execution: ProposalExecution,
        network: NetworkKind,
    ) -> Self {
        Self {
            network,
            interface,
            proposal_execution,
            setup_tx: BTreeMap::new(),
            propose_tx: vec![],
            signer,
        }
    }

    pub fn build(self) -> PlanInstructions {
        PlanInstructions {
            setup: self.setup_tx.into_values().collect(),
            propose: self.propose_tx,
        }
    }

    pub fn payer(&self) -> Pubkey {
        self.signer.pubkey()
    }

    pub fn proposal_payer(&self) -> Pubkey {
        match &self.proposal_execution {
            ProposalExecution::Direct { .. } => self.payer(),
            ProposalExecution::Governance(ctx) => {
                get_native_treasury_address(&ctx.program, &ctx.governance)
            }
        }
    }

    /// Account that invoked programs may expect to sign the proposed instructions.
    pub fn proposal_authority(&self) -> Pubkey {
        match &self.proposal_execution {
            ProposalExecution::Direct { authority } => *authority,
            ProposalExecution::Governance(ctx) => ctx.governance,
        }
    }

    pub async fn account_exists(&self, address: &Pubkey) -> Result<bool, BuilderError> {
        Ok(self.interface.account_exists(address).await?)
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

        Ok(self.interface.try_get_anchor_accounts(&addresses).await?)
    }

    pub fn setup<T: Into<TransactionBuilder>>(
        &mut self,
        phase: SetupPhase,
        txns: impl IntoIterator<Item = T>,
    ) {
        let setup_tx = match self.setup_tx.get_mut(&phase) {
            Some(tx) => tx,
            None => self.setup_tx.entry(phase).or_default(),
        };

        setup_tx.extend(txns.into_iter().map(|t| t.into()))
    }

    pub fn propose(&mut self, instructions: impl IntoIterator<Item = Instruction>) {
        let payer = self.payer();

        let instructions = match &mut self.proposal_execution {
            ProposalExecution::Direct { .. } => instructions
                .into_iter()
                .map(TransactionBuilder::from)
                .collect::<Vec<_>>(),
            ProposalExecution::Governance(ctx) => instructions
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

pub(crate) async fn filter_initializers(
    builder: &Builder,
    ixns: impl IntoIterator<Item = (Pubkey, Instruction)>,
) -> Result<Vec<Instruction>, BuilderError> {
    let (accounts, ixns): (Vec<_>, Vec<_>) = ixns.into_iter().unzip();
    let exists = builder.interface.accounts_exist(&accounts).await?;

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
