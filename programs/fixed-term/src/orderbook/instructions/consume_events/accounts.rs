use std::convert::TryInto;

use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use jet_program_proc_macros::MarketTokenManager;

use crate::{
    control::state::{CrankAuthorization, Market},
    margin::state::{MarginUser, TermLoan},
    orderbook::state::EventQueue,
    serialization::{AnchorAccount, Mut},
    tickets::state::SplitTicket,
    FixedTermErrorCode,
};

#[derive(Accounts, MarketTokenManager)]
pub struct ConsumeEvents<'info> {
    /// The `Market` account tracks global information related to this particular fixed term market
    #[account(
        has_one = ticket_mint @ FixedTermErrorCode::WrongTicketMint,
        has_one = underlying_token_vault @ FixedTermErrorCode::WrongVault,
        has_one = orderbook_market_state @ FixedTermErrorCode::WrongMarketState,
        has_one = event_queue @ FixedTermErrorCode::WrongEventQueue,
    )]
    #[account(mut)]
    pub market: AccountLoader<'info, Market>,
    /// The ticket mint
    /// CHECK: has_one
    #[account(mut)]
    pub ticket_mint: AccountInfo<'info>,
    /// The market token vault
    /// CHECK: has_one
    #[account(mut)]
    pub underlying_token_vault: AccountInfo<'info>,

    // aaob accounts
    /// CHECK: handled by aaob
    #[account(mut)]
    pub orderbook_market_state: AccountInfo<'info>,
    /// CHECK: handled by aaob
    #[account(mut)]
    pub event_queue: AccountInfo<'info>,

    #[account(
        has_one = crank @ FixedTermErrorCode::WrongCrankAuthority,
        constraint = crank_authorization.airspace == market.load()?.airspace @ FixedTermErrorCode::WrongAirspaceAuthorization,
        constraint = crank_authorization.market == market.key() @ FixedTermErrorCode::WrongCrankAuthority,
    )]
    pub crank_authorization: Account<'info, CrankAuthorization>,
    pub crank: Signer<'info>,

    /// The account paying rent for PDA initialization
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    // remaining_accounts: [EventAccounts],
}

/// These are the additional accounts that need to be provided in the ix
/// for every event that will be processed.
/// For a fill, 2-6 accounts need to be appended to remaining_accounts
/// For an out, 1 account needs to be appended to remaining_accounts
pub enum EventAccounts<'info> {
    Fill(Box<FillAccounts<'info>>),
    Out(Box<OutAccounts<'info>>),
}

pub struct FillAccounts<'info> {
    pub maker: UserAccount<'info>,
    /// include if AUTO_STAKE or NEW_DEBT in callback
    pub loan: Option<LoanAccount<'info>>,
    pub maker_adapter: Option<EventQueue<'info>>,
    pub taker_adapter: Option<EventQueue<'info>>,
}

pub enum LoanAccount<'info> {
    /// Use if AUTO_STAKE is set in the maker's callback
    AutoStake(AnchorAccount<'info, SplitTicket, Mut>), // (ticket, user/owner)
    /// Use if NEW_DEBT is set in the maker's callback
    NewDebt(AnchorAccount<'info, TermLoan, Mut>), // (term loan, user)
}

impl<'info> LoanAccount<'info> {
    pub fn auto_stake(&mut self) -> Result<&mut AnchorAccount<'info, SplitTicket, Mut>> {
        match self {
            LoanAccount::AutoStake(split_ticket) => Ok(split_ticket),
            _ => panic!(),
        }
    }

    pub fn new_debt(&mut self) -> Result<&mut AnchorAccount<'info, TermLoan, Mut>> {
        match self {
            LoanAccount::NewDebt(term_loan) => Ok(term_loan),
            _ => panic!(),
        }
    }
}

pub struct OutAccounts<'info> {
    pub user: UserAccount<'info>,
    pub user_adapter_account: Option<EventQueue<'info>>,
}

pub struct UserAccount<'info>(AccountInfo<'info>);
impl<'info> UserAccount<'info> {
    pub fn new(account: AccountInfo<'info>) -> Self {
        Self(account)
    }

    pub fn pubkey(&self) -> Pubkey {
        self.0.key()
    }

    /// token account that will receive a deposit of underlying or tickets
    pub fn as_token_account(&self) -> AccountInfo<'info> {
        self.0.clone()
    }

    /// arbitrary unchecked account that will be granted ownership of a split ticket
    pub fn as_owner(&self) -> AccountInfo<'info> {
        self.0.clone()
    }

    pub fn margin_user(&self) -> Result<AnchorAccount<'info, MarginUser, Mut>> {
        self.0.clone().try_into()
    }
}