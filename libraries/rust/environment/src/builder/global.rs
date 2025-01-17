use solana_sdk::pubkey::Pubkey;

use jet_instructions::{
    airspace::{derive_governor_id, AirspaceIxBuilder},
    control::{get_control_authority_address, ControlIxBuilder},
    margin::{derive_adapter_config, TokenAdmin, TokenConfigUpdate, TokenKind, TokenOracle},
    test_service::{
        self, derive_pyth_price, derive_pyth_product, derive_token_info, derive_token_mint,
        TokenCreateParams,
    },
};

use super::{
    filter_initializers, fixed_term, margin::configure_margin_token, margin_pool, Builder,
    BuilderError, NetworkKind, SetupPhase, TokenContext,
};
use crate::config::{AirspaceConfig, EnvironmentConfig, TokenDescription, DEFAULT_MARGIN_ADAPTERS};

pub async fn configure_environment(
    builder: &mut Builder,
    config: &EnvironmentConfig,
) -> Result<(), BuilderError> {
    if builder.network != config.network {
        return Err(BuilderError::WrongNetwork {
            expected: config.network,
            actual: builder.network,
        });
    }

    let payer = builder.payer();
    let as_ix = AirspaceIxBuilder::new("", payer, builder.proposal_authority());
    let ctrl_ix = ControlIxBuilder::new_for_authority(builder.proposal_authority(), payer);

    // global authority accounts
    builder.setup(
        SetupPhase::TokenMints,
        filter_initializers(
            builder,
            [
                (get_control_authority_address(), ctrl_ix.create_authority()),
                (derive_governor_id(), as_ix.create_governor_id()),
            ],
        )
        .await?,
    );

    let oracle_authority = config.oracle_authority.unwrap_or(payer);

    // airspaces
    for airspace in &config.airspaces {
        configure_airspace(builder, &oracle_authority, airspace).await?;
    }

    // swap pools
    super::swap::create_swap_pools(builder, config).await?;

    Ok(())
}

pub(crate) async fn configure_airspace(
    builder: &mut Builder,
    oracle_authority: &Pubkey,
    config: &AirspaceConfig,
) -> Result<(), BuilderError> {
    let as_ix = AirspaceIxBuilder::new(
        &config.name,
        builder.proposal_payer(),
        builder.proposal_authority(),
    );

    if !builder.account_exists(&as_ix.address()).await? {
        log::info!("create airspace '{}' as {}", &config.name, as_ix.address());
        builder.propose([as_ix.create(builder.proposal_authority(), config.is_restricted)]);
    }

    if builder.network != NetworkKind::Mainnet {
        create_test_tokens(builder, oracle_authority, &config.tokens).await?;
    }

    register_airspace_adapters(builder, &as_ix.address(), DEFAULT_MARGIN_ADAPTERS).await?;

    configure_tokens(
        builder,
        &as_ix.address(),
        &config.cranks,
        oracle_authority,
        &config.tokens,
    )
    .await?;

    Ok(())
}

async fn register_airspace_adapters<'a>(
    builder: &mut Builder,
    airspace: &Pubkey,
    adapters: impl IntoIterator<Item = &'a Pubkey>,
) -> Result<(), BuilderError> {
    builder.propose(
        filter_initializers(
            builder,
            adapters.into_iter().map(|addr| {
                (
                    derive_adapter_config(airspace, addr),
                    builder
                        .margin_config_ix(airspace)
                        .configure_adapter(*addr, true),
                )
            }),
        )
        .await?,
    );

    Ok(())
}

pub async fn configure_tokens<'a>(
    builder: &mut Builder,
    airspace: &Pubkey,
    cranks: &[Pubkey],
    oracle_authority: &Pubkey,
    tokens: impl IntoIterator<Item = &'a TokenDescription>,
) -> Result<(), BuilderError> {
    for desc in tokens {
        let token_context = token_context(builder.network, airspace, *oracle_authority, desc)?;

        // Set margin config for the token itself
        configure_margin_token(
            builder,
            airspace,
            &token_context.mint,
            Some(TokenConfigUpdate {
                underlying_mint: token_context.mint,
                admin: TokenAdmin::Margin {
                    oracle: TokenOracle::Pyth {
                        price: token_context.pyth_price,
                        product: token_context.pyth_product,
                    },
                },
                token_kind: TokenKind::Collateral,
                value_modifier: desc.collateral_weight,
                max_staleness: 0,
            }),
        )
        .await?;

        // Create a pool if configured
        margin_pool::configure_for_token(builder, &token_context).await?;

        // Create any fixed term markets
        for market_config in &desc.fixed_term_markets {
            fixed_term::configure_market_for_token(builder, cranks, &token_context, market_config)
                .await?;
        }
    }

    Ok(())
}

pub fn token_context(
    network: NetworkKind,
    airspace: &Pubkey,
    oracle_authority: Pubkey,
    desc: &TokenDescription,
) -> Result<TokenContext, BuilderError> {
    let (mint, pyth_price, pyth_product) = match network {
        NetworkKind::Localnet | NetworkKind::Devnet => {
            let mint = derive_token_mint(&desc.name);
            let pyth_price = derive_pyth_price(&mint);
            let pyth_product = derive_pyth_product(&mint);

            (mint, pyth_price, pyth_product)
        }

        NetworkKind::Mainnet => {
            let Some(mint) = desc.mint else {
                    return  Err(BuilderError::MissingMint(desc.name.clone()));
                };

            let Some(pyth_price) = desc.pyth_price else {
                    return Err(BuilderError::MissingPythPrice(desc.name.clone()));
                };

            let Some(pyth_product) = desc.pyth_product else {
                    return Err(BuilderError::MissingPythProduct(desc.name.clone()));
                };

            (mint, pyth_price, pyth_product)
        }
    };

    Ok(TokenContext {
        airspace: *airspace,
        desc: desc.clone(),
        oracle_authority,
        mint,
        pyth_price,
        pyth_product,
    })
}

pub async fn create_test_tokens<'a>(
    builder: &mut Builder,
    oracle_authority: &Pubkey,
    tokens: impl IntoIterator<Item = &'a TokenDescription>,
) -> Result<(), BuilderError> {
    let payer = builder.payer();

    let ixns = filter_initializers(
        builder,
        tokens
            .into_iter()
            .map(|desc| match &*desc.symbol {
                // SOL is a bit of a special case, since we want to have an oracle for it but
                // the mint already exists
                "SOL" => {
                    log::info!("register SOL token");

                    Ok((
                        derive_token_info(&spl_token::native_mint::ID),
                        test_service::token_init_native(&payer, oracle_authority),
                    ))
                }

                _ => {
                    let decimals = match desc.decimals {
                        Some(d) => d,
                        None => return Err(BuilderError::MissingDecimals(desc.name.clone())),
                    };
                    let amount_one = 10u64.pow(decimals.into());
                    let max_amount = desc
                        .max_test_amount
                        .map(|x| x * amount_one)
                        .unwrap_or(u64::MAX);

                    log::info!(
                        "create token {} with faucet limit {}",
                        &desc.name,
                        max_amount
                    );

                    Ok((
                        derive_token_mint(&desc.name),
                        test_service::token_create(
                            &payer,
                            &TokenCreateParams {
                                symbol: desc.symbol.clone(),
                                name: desc.name.clone(),
                                authority: builder.proposal_authority(),
                                oracle_authority: *oracle_authority,
                                source_symbol: desc.symbol.clone(),
                                price_ratio: 1.0,
                                decimals,
                                max_amount,
                            },
                        ),
                    ))
                }
            })
            .collect::<Result<Vec<_>, _>>()?,
    )
    .await?;

    builder.setup(SetupPhase::TokenMints, ixns);

    Ok(())
}
