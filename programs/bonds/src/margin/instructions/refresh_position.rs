use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use jet_margin::{AdapterPositionFlags, AdapterResult, PositionChange, PriceChangeInfo};

use crate::{
    control::{events::PositionRefreshed, state::BondManager},
    margin::state::{return_to_margin, MarginUser},
    BondsError,
};

#[derive(Accounts)]
pub struct RefreshPosition<'info> {
    /// The account tracking information related to this particular user
    #[account(
        has_one = bond_manager @ BondsError::UserNotInMarket,
        has_one = margin_account @ BondsError::WrongClaimAccount,
    )]
    pub margin_user: Account<'info, MarginUser>,

    /// CHECK: has_one on orderbook user
    pub margin_account: AccountInfo<'info>,

    /// The `BondManager` account tracks global information related to this particular bond market
    #[account(
        has_one = underlying_oracle @ BondsError::WrongOracle,
        has_one = ticket_oracle @ BondsError::WrongOracle,
    )]
    pub bond_manager: AccountLoader<'info, BondManager>,

    /// The pyth price account
    /// CHECK: has_one on bond manager
    pub underlying_oracle: AccountInfo<'info>,
    pub ticket_oracle: AccountInfo<'info>,

    /// SPL token program
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<RefreshPosition>, expect_price: bool) -> Result<()> {
    let market = ctx.accounts.bond_manager.load()?;
    let mut claim_changes = vec![PositionChange::Flags(
        AdapterPositionFlags::PAST_DUE,
        ctx.accounts.margin_user.debt.is_past_due(),
    )];
    let mut collateral_changes = vec![];
    let mut ticket_changes = vec![];

    // always try to update the price, but conditionally permit position updates if price fails
    // so we can continue to mark positions as past due even if there is an oracle failure
    match load_price(&ctx.accounts.underlying_oracle) {
        Ok(price) => claim_changes.push(price),
        Err(e) if expect_price => Err(e)?,
        Err(e) => msg!("skipping underlying price update due to error: {:?}", e),
    }
    match load_price(&ctx.accounts.ticket_oracle) {
        Ok(price) => {
            collateral_changes.push(price.clone());
            ticket_changes.push(price);
        }
        Err(e) if expect_price => Err(e)?,
        Err(e) => msg!("skipping ticket price update due to error: {:?}", e),
    }

    emit!(PositionRefreshed {
        borrower_account: ctx.accounts.margin_user.key(),
    });

    return_to_margin(
        &ctx.accounts.margin_account.to_account_info(),
        &AdapterResult {
            position_changes: vec![
                (market.claims_mint, claim_changes),
                (market.collateral_mint, collateral_changes),
                (market.bond_ticket_mint, ticket_changes),
            ],
        },
    )
}

fn load_price(oracle_info: &AccountInfo) -> Result<PositionChange> {
    let oracle = pyth_sdk_solana::load_price_feed_from_account_info(oracle_info).map_err(|e| {
        msg!("oracle error in account {}: {:?}", oracle_info.key, e);
        error!(BondsError::OracleError)
    })?;
    let price = oracle.get_current_price().ok_or(BondsError::PriceMissing)?;
    let ema_price = oracle.get_ema_price().ok_or(BondsError::PriceMissing)?;
    Ok(PositionChange::Price(PriceChangeInfo {
        publish_time: oracle.publish_time,
        exponent: oracle.expo,
        value: price.price,
        confidence: price.conf,
        twap: ema_price.price,
    }))
}