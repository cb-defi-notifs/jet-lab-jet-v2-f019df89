import assert from "assert"
import { Address, AnchorProvider, BN, ProgramAccount, translateAddress } from "@project-serum/anchor"
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token"
import {
  AccountMeta,
  AddressLookupTableProgram,
  GetProgramAccountsFilter,
  MemcmpFilter,
  PublicKey,
  Signer,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  TransactionSignature
} from "@solana/web3.js"
import { feesBuffer, Pool, PoolAction } from "./pool/pool"
import {
  AccountPositionListLayout,
  LiquidationData,
  OnChainMarginAccountData
} from "./state"
import { MarginTokenConfig } from "./config"
import { AccountPosition, StorePriceInfo } from "./accountPosition"
import { AssociatedToken, TokenAmount, bnToNumber } from "../token"
import { Number192, findDerivedAccount, sendAll, sendAndConfirm, sendAndConfirmV0 } from "../utils"
import { MarginPrograms } from "./marginClient"
import { FixedTermMarket, refreshAllMarkets } from "../fixed-term"
import { Airspace } from "./airspace"
import { MarginAccountValuation, MarginPosition } from '../wasm'

const LOOKUP_REGISTRY_PROGRAM = new PublicKey("LTR8xXcSrEDsCbTWPY4JmJREFdMz4uYh65uajkVjzru")

/** A description of a position associated with a [[MarginAccount]] and [[Pool]] */
export interface PoolPosition {
  /** The [[MarginTokenConfig]] associated with the [[Pool]] token. */
  tokenConfig: MarginTokenConfig
  /** The [[Pool]] that the position is associated with. */
  pool?: Pool
  /** The underlying [[AccountPosition]] that stores the deposit balance. */
  depositPosition: AccountPosition | undefined
  /** The deposit balance in the [[Pool]]. An undefined `depositPosition` leads to a balance of 0. */
  depositBalance: TokenAmount
  /** The deposit value in the [[Pool]] denominated in USD. An undefined `depositPosition` leads to a value of 0. */
  depositValue: number
  /** The underlying [[AccountPosition]] that stores the loan balance. */
  loanPosition: AccountPosition | undefined
  /** The loan balance in the [[Pool]]. An undefined `loanPosition` leads to a balance of 0. */
  loanBalance: TokenAmount
  /** The loan value in the [[Pool]] denominated in USD. An undefined `loanPosition` leads to a balance of 0. */
  loanValue: number
  /**
   * An estimate of the maximum trade amounts possible.
   * The estimates factor in available wallet balances, [[Pool]] liquidity, margin requirements
   * and [[SETUP_LEVERAGE_FRACTION]]. */
  maxTradeAmounts: Record<PoolAction, TokenAmount>
  buyingPower: TokenAmount
}

export interface AccountSummary {
  depositedValue: number
  borrowedValue: number
  accountBalance: number
  availableCollateral: number
  leverage: number
}

/** A summation of the USD values of various positions used in margin accounting. */
export interface Valuation {
  liabilities: number
  requiredCollateral: number
  requiredSetupCollateral: number
  weightedCollateral: number
  effectiveCollateral: number
  availableCollateral: number
  availableSetupCollateral: number
  assets: number
}

/**
 * A collection of [[AssociatedToken]] wallet balances. Note that only associated token accounts
 * will be present and auxiliary accounts are ignored.
 */
export interface MarginWalletTokens {
  /** An array of every associated token account owned by the wallet. */
  all: AssociatedToken[]
  /** A map of token symbols to associated token accounts.
   *
   * ## Usage
   *
   * ```ts
   * map["USDC"].amount.tokens.toFixed(2)
   * ```
   *
   * ## Remarks
   *
   * Only tokens within the [[MarginConfig]] will be present. */
  map: Record<string, AssociatedToken>
}

export class MarginAccount {
  /**
   * The maximum [[MarginAccount]] seed value equal to `65535`.
   * Seeds are a 16 bit number and therefor only 2^16 margin accounts may exist per wallet. */
  static readonly SEED_MAX_VALUE = 65535
  static readonly RISK_WARNING_LEVEL = 0.8
  static readonly RISK_CRITICAL_LEVEL = 0.9
  static readonly RISK_LIQUIDATION_LEVEL = 1
  /** The maximum risk indicator allowed by the library when setting up a  */
  static readonly SETUP_LEVERAGE_FRACTION = 0.5

  static readonly MAX_POOL_UTIL_RATIO_AFTER_BORROW = 0.95

  /** The raw accounts associated with the margin account. */
  info?: {
    /** The decoded [[LiquidationData]]. This may only be present during liquidation. */
    liquidationData?: LiquidationData
    /** The decoded position data in the margin account. */
    positions: AccountPosition[]
  }

  /** The address of the [[MarginAccount]] */
  address: PublicKey
  /** The owner of the [[MarginAccount]] */
  owner: PublicKey
  /** The address of the airspace this account is part of */
  airspace: PublicKey

  /** The address of the current liquidator. Default if nonw */
  liquidator: PublicKey
  /** The parsed [[AccountPosition]] array of the margin account. */
  positions: AccountPosition[]
  /** The summarized [[PoolPosition]] array of pool deposits and borrows. */
  poolPositions: Record<string, PoolPosition>
  /** The [[Valuation]] of the margin account. */
  valuation: MarginAccountValuation
  summary: AccountSummary
  prices?: Record<string, StorePriceInfo>

  /**
   * Returns true if a liquidator address is associated with the [[MarginAccount]].
   * Certain actions are not allowed while liquidation is in progress.
   */
  get isBeingLiquidated() {
    return !this.liquidator.equals(PublicKey.default)
  }

  /** A qualitative measure of the the health of a margin account.
   * A higher value means more risk in a qualitative sense.
   * Properties:
   *  non-negative, range is [0, infinity)
   *  zero only when an account has no exposure at all
   *  account is subject to liquidation at a value of one
   */
  get riskIndicator() {
    return this.computeRiskIndicator(
      this.valuation.requiredCollateral,
      this.valuation.weightedCollateral,
      this.valuation.liabilities
    )
  }

  /** Compute the risk indicator using components from [[Valuation]] */
  computeRiskIndicator(requiredCollateral: number, weightedCollateral: number, liabilities: number): number {
    if (requiredCollateral < 0) throw Error("requiredCollateral must be non-negative")
    if (weightedCollateral < 0) throw Error("weightedCollateral must be non-negative")
    if (liabilities < 0) throw Error("liabilities must be non-negative")

    if (weightedCollateral > 0) {
      return (requiredCollateral + liabilities) / weightedCollateral
    } else if (requiredCollateral + liabilities > 0) {
      return Infinity
    } else {
      return 0
    }
  }

  /**
   * Creates an instance of margin account.
   * @param {MarginPrograms} programs
   * @param {Provider} provider The provider and wallet that can sign for this margin account
   * @param {Address} owner
   * @param {number} seed
   * @param {Address} airspaceAddress Address of the airspace. If not provided, uses the first value found in the config
   * @param {Record<string, Pool>} pools
   * @param {MarginWalletTokens} walletTokens
   * @memberof MarginAccount
   */
  constructor(
    public programs: MarginPrograms,
    public provider: AnchorProvider,
    owner: Address,
    public seed: number,
    fixedTermOpenOrders: Record<string, OpenOrders>,
    fixedTermOpenPositions: Record<string, OpenPositions>,
    public airspaceAddress?: Address,
    public pools?: Record<string, Pool>,
    public walletTokens?: MarginWalletTokens,
    prices?: Record<string, StorePriceInfo>
  ) {
    this.owner = translateAddress(owner)
    this.address = MarginAccount.derive(programs, owner, seed)
    this.airspace = airspaceAddress
      ? translateAddress(airspaceAddress)
      : Airspace.deriveAddress(programs.airspace.programId, programs.config.airspaces[0].name)
    this.liquidator = PublicKey.default
    this.pools = pools
    this.walletTokens = walletTokens
    this.prices = prices
    this.positions = this.getPositions()
    this.valuation = this.getValuation({
      openPositions: this.extractFixedTermPositions(fixedTermOpenPositions),
      openOrders: this.extractFixedTermOrders(fixedTermOpenOrders)
    })
    this.poolPositions = this.getAllPoolPositions()
    this.summary = this.getSummary()
  }

  /**
   * Derive margin account PDA from owner address and seed
   *
   * @private
   * @static
   * @param {MarginPrograms} programs
   * @param {Address} owner
   * @param {number} seed
   * @return {PublicKey}
   * @memberof MarginAccount
   */
  static derive(programs: MarginPrograms, owner: Address, seed: number): PublicKey {
    if (seed > this.SEED_MAX_VALUE || seed < 0) {
      console.log(`Seed is not within the range: 0 <= seed <= ${this.SEED_MAX_VALUE}.`)
    }
    const buffer = Buffer.alloc(2)
    buffer.writeUInt16LE(seed)
    const marginAccount = findDerivedAccount(programs.config.marginProgramId, owner, buffer)

    return marginAccount
  }

  /**
   * Derive the address of a [[LiquidationData]] account.
   *
   * @param {Address} liquidator
   * @return {PublicKey}
   * @memberof MarginAccount
   */
  findLiquidationAddress(liquidator: Address): PublicKey {
    return findDerivedAccount(this.programs.config.marginProgramId, this.address, liquidator)
  }
  /**
   * Derive the address of an active [[LiquidationState]] account.
   *
   * @return {PublicKey}
   * @memberof MarginAccount
   */
  findLiquidationStateAddress(): PublicKey {
    return findDerivedAccount(this.programs.config.marginProgramId, "liquidation", this.address, this.liquidator!)
  }

  /**
   * Derive the address of an airspace permit account.
   *
   * ## Remarks
   *
   * All margin accounts are associated with an airspace. The permit determines
   * actions a signer is allowed to take within an airspace.
   *
   * @return {PublicKey}
   * @memberof MarginAccount
   */
  findAirspacePermitAddress(): PublicKey {
    return findDerivedAccount(this.programs.config.airspaceProgramId, "airspace-permit", this.airspace!, this.owner)
  }

  /**
   * Derive the address of a position token account associated with a [[MarginAccount]]
   * and position token mint.
   *
   * ## Remarks
   *
   * It is recommended to use other functions to find specfic position types. e.g. using [[Pool]].findDepositPositionAddress
   *
   * @param {Address} positionTokenMint
   * @return {PublicKey}
   * @memberof MarginAccount
   */
  findPositionTokenAddress(positionTokenMint: Address): PublicKey {
    const positionTokenMintAddress = translateAddress(positionTokenMint)
    return findDerivedAccount(this.programs.config.marginProgramId, this.address, positionTokenMintAddress)
  }

  /**
   * Derive the address of the config account for a given token.
   *
   * @param tokenMint The mint address for the token to derive the config address for.
   */
  findTokenConfigAddress(tokenMint: Address): PublicKey {
    return findDerivedAccount(this.programs.config.marginProgramId, "token-config", this.airspace, tokenMint)
  }

  /**
   *
   * @param args
   * @param {MarginPrograms} args.programs
   * @param {AnchorProvider} args.provider The provider and wallet that can sign for this margin account
   * @param {Record<string, Pool>} args.pools Collection of [[Pool]] to calculate pool positions and prices.
   * @param {MarginWalletTokens} args.walletTokens Tokens owned by the wallet to calculate max deposit amounts.
   * @param {Address} args.owner
   * @param {number} args.seed
   * @returns {Promise<MarginAccount>}
   */
  static async load({
    programs,
    provider,
    airspaceAddress,
    pools,
    walletTokens,
    owner,
    seed,
    prices,
    fixedTermOpenOrders,
    fixedTermOpenPositions
  }: {
    programs: MarginPrograms
    provider: AnchorProvider
    airspaceAddress?: Address
    pools?: Record<string, Pool>
    walletTokens?: MarginWalletTokens
    owner: Address
    seed: number
    prices: Record<string, StorePriceInfo>,
    fixedTermOpenOrders: Record<string, OpenOrders>,
    fixedTermOpenPositions: Record<string, OpenPositions>,
  }): Promise<MarginAccount> {
    const marginAccount = new MarginAccount(
      programs,
      provider,
      owner,
      seed,
      fixedTermOpenOrders,
      fixedTermOpenPositions,
      airspaceAddress,
      pools,
      walletTokens,
      prices
    )
    // Get orders and positions of the margin account

    await marginAccount.refresh({
      openPositions: marginAccount.extractFixedTermPositions(fixedTermOpenPositions),
      openOrders: marginAccount.extractFixedTermOrders(fixedTermOpenOrders)
    })
    return marginAccount
  }

  /**
   * Load all margin accounts for a wallet with an optional filter.
   *
   * @static
   * @param {({
   *     programs: MarginPrograms
   *     provider: AnchorProvider
   *     pools?: Record<string, Pool>
   *     walletTokens?: MarginWalletTokens
   *     filters?: GetProgramAccountsFilter[] | Buffer
   *   })} {
   *     programs,
   *     provider,
   *     pools,
   *     walletTokens,
   *     filters
   *   }
   * @return {Promise<MarginAccount[]>}
   * @memberof MarginAccount
   */
  static async loadAllByOwner({
    programs,
    provider,
    pools,
    walletTokens,
    owner,
    filters,
    prices,
    fixedTermOpenOrders,
    fixedTermOpenPositions,
    doRefresh = true,
    doFilterAirspace = true
  }: {
    programs: MarginPrograms
    provider: AnchorProvider
    pools?: Record<string, Pool>
    walletTokens?: MarginWalletTokens
    owner: Address
    filters?: GetProgramAccountsFilter[]
    prices?: Record<string, StorePriceInfo>
    fixedTermOpenOrders: Record<string, OpenOrders>
    fixedTermOpenPositions: Record<string, OpenPositions>
    doRefresh?: boolean
    doFilterAirspace?: boolean
  }): Promise<MarginAccount[]> {
    const ownerFilter: MemcmpFilter = {
      memcmp: {
        offset: 16,
        bytes: owner.toString()
      }
    }

    const airspaceFilter: MemcmpFilter = {
      memcmp: {
        offset: 48,
        bytes: Airspace.deriveAddress(programs.airspace.programId, programs.config.airspaces[0].name).toString()
      }
    }

    filters ??= []
    filters.push(ownerFilter)
    if (doFilterAirspace) filters.push(airspaceFilter)
    const infos: ProgramAccount<OnChainMarginAccountData>[] = await programs.margin.account.marginAccount.all(filters)
    const marginAccounts: MarginAccount[] = []
    for (let i = 0; i < infos.length; i++) {
      if (infos[i]) {
        const { account } = infos[i]
        const seed = bnToNumber(new BN(account.userSeed, undefined, "le"))
        const marginAccount = new MarginAccount(
          programs,
          provider,
          account.owner,
          seed,
          fixedTermOpenOrders,
          fixedTermOpenPositions,
          account.airspace,
          pools,
          walletTokens,
          prices
        )
        if (doRefresh) {
          await marginAccount.refresh({
            openPositions: marginAccount.extractFixedTermPositions(fixedTermOpenPositions),
            openOrders: marginAccount.extractFixedTermOrders(fixedTermOpenOrders)
          })
        }
        marginAccounts.push(marginAccount)
      }
    }
    return marginAccounts
  }

  /**
   * Load all margin accounts for a wallet from a data cache.
   *
   * @static
   * @param {({
  *     programs: MarginPrograms
  *     provider: AnchorProvider
  *     pools?: Record<string, Pool>
  *     walletTokens?: MarginWalletTokens
  *     filters?: GetProgramAccountsFilter[] | Buffer
  *   })} {
  *     programs,
  *     provider,
  *     pools,
  *     walletTokens,
  *     filters
  *   }
  * @return {Promise<MarginAccount[]>}
  * @memberof MarginAccount
  */
  static async loadAllByOwnerFromCache({
    programs,
    provider,
    pools,
    walletTokens,
    owner,
    prices,
    fixedTermOpenOrders,
    fixedTermOpenPositions,
    accountData,
    doFilterAirspace = true
  }: {
    programs: MarginPrograms
    provider: AnchorProvider
    pools?: Record<string, Pool>
    walletTokens?: MarginWalletTokens
    owner: Address
    prices?: Record<string, StorePriceInfo>
    fixedTermOpenOrders: Record<string, OpenOrders>
    fixedTermOpenPositions: Record<string, OpenPositions>
    accountData: MarginAccountData[]
    doFilterAirspace?: boolean
  }): Promise<MarginAccount[]> {

    const marginAccounts: MarginAccount[] = []
    const airspace = Airspace.deriveAddress(programs.airspace.programId, programs.config.airspaces[0].name).toBase58()
    accountData.filter(data => {
      if (doFilterAirspace) {
        return data.airspace === airspace && data.owner === owner.toString()
      } else {
        return data.owner === owner.toString()
      }
    }).forEach(account => {
      const marginAccount = new MarginAccount(
        programs,
        provider,
        account.owner,
        account.seed,
        fixedTermOpenOrders,
        fixedTermOpenPositions,
        account.airspace,
        pools,
        walletTokens,
        prices
      )
      marginAccount.liquidator = new PublicKey(account.liquidator)
      marginAccount.setPositions(account)
      marginAccount.recalculate({
        openOrders: marginAccount.extractFixedTermOrders(fixedTermOpenOrders),
        openPositions: marginAccount.extractFixedTermPositions(fixedTermOpenPositions)
      })
      marginAccounts.push(marginAccount)
    })
    return marginAccounts
  }

  setPositions(data: MarginAccountData) {
    this.info = this.info ?? {
      positions: data.positions.map(data => {
        const price = this.getPositionPrice(new PublicKey(data.token))
        return AccountPosition.fromCache({
          data, price
        })
      })
    }
  }

  /** Recalculate margin account information using the cache as far as possible */
  async recalculate(fixedTerm: {
    openPositions: OpenPositions[],
    openOrders: OpenOrders[]
  }) {
    this.positions = this.getPositions()
    this.valuation = this.getValuation(fixedTerm)
    this.poolPositions = this.getAllPoolPositions()
    this.summary = this.getSummary()
  }

  async refresh({
    openPositions,
    openOrders
  }: {
    openPositions: OpenPositions[],
    openOrders: OpenOrders[]
  }) {
    const marginAccount = await this.programs.margin.account.marginAccount.fetchNullable(this.address)
    const positions = marginAccount ? AccountPositionListLayout.decode(new Uint8Array(marginAccount.positions)) : null
    if (!marginAccount || !positions) {
      this.info = undefined
    } else {
      // Account is being liquidated
      this.liquidator = marginAccount.liquidator
      let liquidationData: LiquidationData | undefined = undefined
      if (!marginAccount.liquidator.equals(PublicKey.default)) {
        liquidationData =
          (await this.programs.margin.account.LiquidationState.fetchNullable(this.findLiquidationStateAddress()))
            ?.state ?? undefined
      }
      this.info = {
        liquidationData,
        positions: !positions ? [] : positions.positions.map(info => {
          const price = this.getPositionPrice(new PublicKey(info.token))
          return new AccountPosition({ info, price })
        })
      }
    }
    this.positions = this.getPositions()
    this.valuation = this.getValuation({
      openPositions, openOrders
    })
    this.poolPositions = this.getAllPoolPositions()
    this.summary = this.getSummary()
  }

  private getAllPoolPositions(): Record<string, PoolPosition> {
    const positions: Record<string, PoolPosition> = {}
    const poolConfigs = Object.values(this.programs.config.tokens)

    for (let i = 0; i < poolConfigs.length; i++) {
      const tokenConfig = poolConfigs[i]
      const pool = this.pools?.[tokenConfig.symbol]
      if (!pool?.info) {
        continue
      }

      // Deposits
      const depositNotePosition = this.getPositionNullable(pool.addresses.depositNoteMint)
      const depositBalanceNotes = Number192.from(depositNotePosition?.balance ?? new BN(0))
      const depositBalance = depositBalanceNotes.mul(pool.depositNoteExchangeRate()).toTokenAmount(pool.decimals)
      const depositValue = depositNotePosition?.value ?? 0

      // Loans
      const loanNotePosition = this.getPositionNullable(pool.addresses.loanNoteMint)
      const loanBalanceNotes = Number192.from(loanNotePosition?.balance ?? new BN(0))
      const loanBalance = loanBalanceNotes.mul(pool.loanNoteExchangeRate()).toTokenAmount(pool.decimals)
      const loanValue = loanNotePosition?.value ?? 0

      // Max trade amounts
      const maxTradeAmounts = this.getMaxTradeAmounts(pool, depositBalance, loanBalance)

      // Buying power
      // FIXME
      const buyingPower = TokenAmount.zero(pool.decimals)

      positions[tokenConfig.symbol] = {
        tokenConfig,
        pool,
        depositPosition: depositNotePosition,
        loanPosition: loanNotePosition,
        depositBalance,
        depositValue,
        loanBalance,
        loanValue,
        maxTradeAmounts,
        buyingPower
      }
    }

    return positions
  }

  private getMaxTradeAmounts(
    pool: Pool,
    depositBalance: TokenAmount,
    loanBalance: TokenAmount
  ): Record<PoolAction, TokenAmount> {
    const zero = TokenAmount.zero(pool.decimals)
    if (!pool.info) {
      return {
        deposit: zero,
        withdraw: zero,
        borrow: zero,
        repay: zero,
        repayFromDeposit: zero,
        swap: zero,
        transfer: zero
      }
    }

    // Wallet's balance for pool
    // If depsiting or repaying SOL, maximum input should consider fees
    let walletAmount = TokenAmount.zero(pool.decimals)
    if (pool.symbol && this.walletTokens) {
      walletAmount = this.walletTokens.map[pool.symbol].amount
    }
    if (pool.tokenMint.equals(NATIVE_MINT)) {
      walletAmount = TokenAmount.max(walletAmount.subb(feesBuffer), TokenAmount.zero(pool.decimals))
    }

    const token = pool.tokenMint.toBase58()
    const decimals = pool.decimals
    const tokenPrice = this.prices![token]?.price ?? 0.0

    // Max deposit
    const deposit = walletAmount

    const depositNoteValueModifier =
      this.getPositionNullable(pool.addresses.depositNoteMint)?.valueModifier ?? pool.depositNoteMetadata.valueModifier
    const loanNoteValueModifier =
      this.getPositionNullable(pool.addresses.loanNoteMint)?.valueModifier ?? pool.loanNoteMetadata.valueModifier

    // Max withdraw
    let withdraw = TokenAmount.tokens(
      this.valuation.availableSetupCollateral / depositNoteValueModifier / tokenPrice,
      decimals
    )
    withdraw = TokenAmount.min(withdraw, depositBalance)
    withdraw = TokenAmount.min(withdraw, pool.vault)
    withdraw = TokenAmount.max(withdraw, zero)

    // Max borrow
    const vault = pool.vault
    const borrows = pool.borrowedTokens
    const u = MarginAccount.MAX_POOL_UTIL_RATIO_AFTER_BORROW
    const effectiveVaultForBorrow = vault.muln(u).sub(borrows.muln(1 - u))

    let borrow = TokenAmount.tokens(
      this.valuation.availableSetupCollateral /
      (1 - depositNoteValueModifier + 1 / (loanNoteValueModifier * MarginAccount.SETUP_LEVERAGE_FRACTION)),
      decimals
    )
    borrow = TokenAmount.min(borrow, effectiveVaultForBorrow)
    borrow = TokenAmount.max(borrow, zero)

    // Max repay
    const repay = TokenAmount.min(loanBalance, walletAmount)
    const repayFromDeposit = TokenAmount.min(loanBalance, depositBalance)

    // Max swap
    const swap = TokenAmount.min(depositBalance.add(borrow), pool.vault)

    // Max transfer
    const transfer = withdraw

    return {
      deposit,
      withdraw,
      borrow,
      repay,
      repayFromDeposit,
      swap,
      transfer
    }
  }

  private getSummary(): AccountSummary {
    let leverage = 1.0
    const assets = this.valuation.assets
    const liabilities = this.valuation.liabilities
    const equity = assets - liabilities

    if (equity >= 0) {
      leverage = assets / equity
    } else {
      leverage = 999.9 // This is better than infinity
    }

    const availableCollateral = this.valuation.availableCollateral

    return {
      depositedValue: assets,
      borrowedValue: liabilities,
      accountBalance: equity,
      availableCollateral,
      leverage
    }
  }

  /**
   * Get the array of regstered [[AccountPosition]] on this account
   *
   * @return {AccountPosition[]}
   * @memberof MarginAccount
   */
  getPositions(): AccountPosition[] {
    return (this.info?.positions ?? [])
      .filter(position => !position.address.equals(PublicKey.default))
  }
  /**
   * Get the registerd [[AccountPosition]] associated with the position mint.
   * Throws an error if the position does not exist.
   *
   * @param {Address} mint The position mint. For example a [[Pool]] deposit note mint.
   * @return {(AccountPosition)}
   * @memberof MarginAccount
   */
  getPosition(mint: Address): AccountPosition {
    const position = this.getPositionNullable(mint)
    assert(position)
    return position
  }

  /**
   * Get the registerd [[AccountPosition]] associated with the position mint.
   *
   * @param {Address} mint The position mint. For example a [[Pool]] deposit note mint.
   * @return {(AccountPosition | undefined)}
   * @memberof MarginAccount
   */
  getPositionNullable(mint: Address): AccountPosition | undefined {
    const mintAddress = translateAddress(mint)

    for (let i = 0; i < this.positions.length; i++) {
      const position = this.positions[i]
      if (position.token.equals(mintAddress)) {
        return position
      }
    }
    return
  }

  getPositionPrice(mint: PublicKey) {
    if (this.prices) {
      return this.prices[mint.toBase58()]
    } else {
      return undefined
    }
  }

  /**
   * Check if the given address is an authority for this margin account.
   * The owner has authority, as well as a liquidator only during liquidation.
   */
  hasAuthority(authority: PublicKey) {
    return authority.equals(this.owner) || this.liquidator?.equals(authority)
  }

  /**
   * Project the valuation of the margin account based on provided changes
   */
  projectValuation(changes: MarginPosition[], prices?: Record<string, StorePriceInfo>): MarginAccountValuation {
    const priceEntries = Object.entries((prices ?? {}));
    const input = {
      positions: new Map<string, any>(this.positions.map(position => [position.address.toBase58(), {
        address: position.address.toBase58(),
        token: position.token.toBase58(),
        balance: position.balance.toNumber(),
        exponent: position.exponent,
        position_kind: position.kind,
        value_modifier: position.valueModifier
      }])),
      changes,
      prices: new Map(priceEntries.map(([key, value]) => [key, {
        price: value.price,
      }])),
    }
    return new MarginAccountValuation(input)
  }

  private getValuation(_fixedTerm: { openPositions: OpenPositions[], openOrders: OpenOrders[] }): MarginAccountValuation {
    return this.projectValuation([], this.prices ?? {})

    // // The above does not include adapter positions, so we add the individual positions
    // // making up the fixed term positions and orders
    // openOrders.forEach(orders => {
    //   const price = this.getPositionPrice(new PublicKey(orders.underlying_mint));
    //   if (price && this.pools) {
    //     const decimals = Object.values(this.pools).find(pool => pool.addresses.tokenMint.toBase58() === orders.underlying_mint)?.decimals ?? 6;
    //     assets += orders.unfilled_lend * price.price * Math.pow(10, -decimals);
    //     assets += orders.unfilled_borrow * price.price * Math.pow(10, -decimals);
    //   }
    // })
    // const now = Date.now();
    // openPositions.forEach(positions => {
    //   const price = this.getPositionPrice(new PublicKey(positions.underlying_mint));
    //   if (price && this.pools) {
    //     const decimals = Object.values(this.pools).find(pool => pool.addresses.tokenMint.toBase58() === positions.underlying_mint)?.decimals ?? 6;
    //     // Sum each term deposits, factoring in accrued interest
    //     positions.deposits.forEach(deposit => {
    //       const accrual = Math.min(Math.abs((now - deposit.created_timestamp) / (deposit.maturation_timestamp - deposit.created_timestamp)), 1.0);
    //       const value = deposit.principal + (deposit.interest * accrual);
    //       assets += value * price.price * Math.pow(10, -decimals)
    //     })
    //   }
    // })

    // const effectiveCollateral = weightedCollateral - liabilities
    // const availableCollateral = weightedCollateral - liabilities - requiredCollateral
    // const availableSetupCollateral = weightedCollateral - liabilities - requiredSetupCollateral
  }

  /**
   * Loads all tokens in the users wallet.
   * Provides an array and a map of tokens mapped by pool.
   *
   * @static
   * @param {MarginPrograms} programs
   * @param {Address} owner
   * @return {Promise<MarginWalletTokens>}
   * @memberof MarginAccount
   */
  static async loadTokens(programs: MarginPrograms, owner: Address): Promise<MarginWalletTokens> {
    const poolConfigs = Object.values(programs.config.tokens)

    const ownerAddress = translateAddress(owner)

    const all = await AssociatedToken.loadMultipleOrNative({
      connection: programs.margin.provider.connection,
      owner: ownerAddress
    })

    // Build out the map
    const map: Record<string, AssociatedToken> = {}
    for (let i = 0; i < poolConfigs.length; i++) {
      const tokenConfig = poolConfigs[i]

      // Find the associated token pubkey
      const mint = translateAddress(tokenConfig.mint)
      const associatedTokenOrNative = mint.equals(NATIVE_MINT)
        ? ownerAddress
        : AssociatedToken.derive(mint, ownerAddress)

      // Find the associated token from the loadMultiple query
      let token = all.find(token => token.address.equals(associatedTokenOrNative))
      if (token === undefined) {
        token = AssociatedToken.zeroAux(associatedTokenOrNative, tokenConfig.decimals)
      }

      // Add it to the map
      map[tokenConfig.symbol] = token
    }
    return { all, map }
  }
  /**
   * Fetches the account and returns if it exists.
   *
   * @return {Promise<boolean>}
   * @memberof MarginAccount
   */
  static async exists(programs: MarginPrograms, owner: Address, seed: number): Promise<boolean> {
    const ownerPubkey = translateAddress(owner)
    const marginAccount = this.derive(programs, ownerPubkey, seed)
    const info = await programs.margin.provider.connection.getAccountInfo(marginAccount)
    return !!info
  }

  /**
   * Fetches the account and returns if it exists
   *
   * @return {Promise<boolean>}
   * @memberof MarginAccount
   */
  async exists(): Promise<boolean> {
    return await MarginAccount.exists(this.programs, this.owner, this.seed)
  }

  /**
   * Create the margin account if it does not exist.
   * If no seed is provided, one will be located.
   *
   * ## Example
   *
   * ```javascript
   * // Load programs
   * const config = await MarginClient.getConfig("devnet")
   * const programs = MarginClient.getPrograms(provider, config)
   *
   * // Load tokens and wallet
   * const pools = await poolManager.loadAll()
   * const walletTokens = await MarginAccount.loadTokens(programs, walletPubkey)
   *
   * // Create margin account
   * const marginAccount = await MarginAccount.createAccount({
   *   programs,
   *   provider,
   *   owner: wallet.publicKey,
   *   seed: 0,
   *   pools,
   *   walletTokens
   * })
   * ```
   *
   * @static
   * @param args
   * @param {MarginPrograms} args.programs
   * @param {AnchorProvider} args.provider A provider that may be used to sign transactions modifying the account
   * @param {Address} args.owner The address of the [[MarginAccount]] owner
   * @param {number} args.seed The seed or ID of the [[MarginAccount]] in the range of (0, 65535]
   * @param {Record<string, Pool>} args.pools A [[Pool]] collection to calculate pool positions.
   * @param {MarginWalletTokens} args.walletTokens The tokens in the owners wallet to determine max trade amounts.
   * @return {Promise<MarginAccount>}
   * @memberof MarginAccount
   */
  static async createAccount({
    programs,
    provider,
    owner,
    seed,
    airspaceAddress,
    pools,
    walletTokens,
    fixedTermOpenOrders,
    fixedTermOpenPositions
  }: {
    programs: MarginPrograms
    provider: AnchorProvider
    owner: Address
    seed?: number
    airspaceAddress?: Address
    pools?: Record<string, Pool>
    walletTokens?: MarginWalletTokens
    fixedTermOpenOrders: Record<string, OpenOrders>
    fixedTermOpenPositions: Record<string, OpenPositions>
  }): Promise<MarginAccount> {
    if (seed === undefined) {
      seed = await this.getUnusedAccountSeed({ programs, provider, owner })
    }
    const marginAccount = new MarginAccount(
      programs,
      provider,
      owner,
      seed,
      fixedTermOpenOrders,
      fixedTermOpenPositions,
      airspaceAddress,
      pools,
      walletTokens
    )
    const instructions: TransactionInstruction[] = []
    await marginAccount.withCreateAccount(instructions)
    // Add a lookup registry account
    await marginAccount.withInitLookupRegistry(instructions)
    const slot = await provider.connection.getSlot()
    await marginAccount.withCreateLookupTable({
      instructions,
      slot,
      discriminator: 10
    })
    await marginAccount.sendAndConfirm(instructions)
    return marginAccount
  }

  /**
   * Searches for a margin account that does not exist yet and returns its seed.
   *
   * @static
   * @param {{
   *     programs: MarginPrograms
   *     provider: AnchorProvider
   *     owner: Address
   *   }}
   * @memberof MarginAccount
   */
  static async getUnusedAccountSeed({
    programs,
    provider,
    owner
  }: {
    programs: MarginPrograms
    provider: AnchorProvider
    owner: Address
  }) {
    let accounts = await MarginAccount.loadAllByOwner({
      programs,
      provider,
      owner,
      // Safe to use defaults, looking for unused accounts
      fixedTermOpenOrders: {},
      fixedTermOpenPositions: {},
      doRefresh: false,
      doFilterAirspace: false
    })
    accounts = accounts.sort((a, b) => a.seed - b.seed)
    // Return any gap found in account seeds
    for (let i = 0; i < accounts.length; i++) {
      const seed = accounts[i].seed
      if (seed !== i) {
        return seed
      }
    }

    // Return +1
    return accounts.length
  }

  /**
   * Create the margin account if it does not exist.
   * If no seed is provided, one will be located.
   *
   * ## Example
   *
   * ```javascript
   * // Load programs
   * const config = await MarginClient.getConfig("devnet")
   * const programs = MarginClient.getPrograms(provider, config)
   *
   * // Load tokens and wallet
   * const pools = await poolManager.loadAll()
   * const walletTokens = await MarginAccount.loadTokens(programs, walletPubkey)
   *
   * // Create margin account
   * const marginAccount = new MarginAccount({
   *    programs,
   *    provider,
   *    walletPubkey,
   *    0,
   *    pools,
   *    walletTokens
   * })
   *
   * await marginAccount.createAccount()
   * ```
   *
   * @return {Promise<void>}
   * @memberof MarginAccount
   */
  async createAccount(): Promise<string> {
    const instructions: TransactionInstruction[] = []
    await this.withCreateAccount(instructions)
    return await this.sendAndConfirmV0([instructions], [])
  }

  /**
   * Get instruction to create the account if it does not exist.
   *
   * ## Example
   *
   * ```ts
   * const instructions: TransactionInstruction[] = []
   * await marginAccount.withCreateAccount(instructions)
   * if (instructions.length > 0) {
   *   await marginAccount.sendAndConfirm(instructions)
   * }
   * ```
   *
   * @param {TransactionInstruction[]} instructions
   * @return {Promise<void>}
   * @memberof MarginAccount
   */
  async withCreateAccount(instructions: TransactionInstruction[]): Promise<void> {
    if (!(await this.exists())) {
      const permit = this.findAirspacePermitAddress()
      const permitExists = await this.provider.connection.getAccountInfo(permit)

      if (!permitExists) {
        const airspace = await Airspace.load(this.programs.airspace, this.airspace)
        if (airspace.info!.isRestricted) {
          throw Error("Permit cannot be created for a restricted airspace")
        }
        const issuerId = airspace.derivePermitIssuerId(this.owner)
        const permitIx = await this.programs.airspace.methods
          .airspacePermitCreate(this.owner)
          .accounts({
            payer: this.provider.wallet.publicKey,
            authority: this.owner,
            airspace: this.airspace,
            permit,
            issuerId,
            systemProgram: SystemProgram.programId
          })
          .instruction()
        instructions.push(permitIx)
      }
      const createIx = await this.programs.margin.methods
        .createAccount(this.seed)
        .accounts({
          owner: this.owner,
          permit,
          payer: this.provider.wallet.publicKey,
          marginAccount: this.address,
          systemProgram: SystemProgram.programId
        })
        .instruction()
      instructions.push(createIx)
    } else {
      console.log("account already exists")
    }
  }

  /**
   * Updates all position balances. `withUpdatePositionBalance` is often included
   * in transactions after modifying balances to synchronize with the margin account.
   *
   * @return {Promise<string>}
   * @memberof MarginAccount
   */
  async updateAllPositionBalances(): Promise<string> {
    const instructions: TransactionInstruction[] = []
    await this.withUpdateAllPositionBalances({ instructions })
    return await this.sendAndConfirm(instructions)
  }

  /**
   * Create instructions to update all position balances. `withUpdatePositionBalance` often included in
   * transactions after modifying balances ot synchronize with the margin account.
   *
   * ## Example
   *
   * ```ts
   * const instructions: TransactionInstruction[] = []
   * await marginAccount.withUpdateAllPositionBalances({ instructions })
   * await marginAccount.sendAndConfirm(instructions)
   * ```
   *
   * @param {{ instructions: TransactionInstruction[] }} { instructions }
   * @memberof MarginAccount
   */
  async withUpdateAllPositionBalances({ instructions }: { instructions: TransactionInstruction[] }) {
    for (const position of this.positions) {
      await this.withUpdatePositionBalance({ instructions, position: position.address })
    }
  }

  /**
   * Updates a single position balance. `withUpdatePositionBalance` is often included
   * in transactions after modifying balances to synchronize with the margin account.
   *
   * @param {{ position: AccountPosition }} { position }
   * @return {Promise<string>}
   * @memberof MarginAccount
   */
  async updatePositionBalance({ position }: { position: AccountPosition }): Promise<string> {
    const instructions: TransactionInstruction[] = []
    await this.withUpdatePositionBalance({ instructions, position: position.address })
    return await this.sendAndConfirm(instructions)
  }

  /**
   * Get instruction to update the accounting for assets in
   * the custody of the margin account.
   *
   * ## Example
   *
   * ```ts
   * // Load the pools
   * const poolManager = new PoolManager(programs, provider)
   * const pools = await poolManager.loadAll()
   *
   * // Find the position
   * const depositNote = pools["SOL"].addresses.depositNoteMint
   * const position = marginAccount.getPosition(depositNote).address
   *
   * // Update the position balance
   * const instructions: TransactionInstruction[] = []
   * await marginAccount.withUpdatePositionBalance({ instructions, position })
   * await marginAccount.sendAndConfirm(instructions)
   * ```
   *
   * @param {{
   *     instructions: TransactionInstruction[]
   *     position: Address
   *   }} {
   *     instructions,
   *     position
   *   }
   * @return {*}  {Promise<void>}
   * @memberof MarginAccount
   */
  async withUpdatePositionBalance({
    instructions,
    position
  }: {
    instructions: TransactionInstruction[]
    position: Address
  }): Promise<void> {
    const instruction = await this.programs.margin.methods
      .updatePositionBalance()
      .accounts({
        marginAccount: this.address,
        tokenAccount: position
      })
      .instruction()
    instructions.push(instruction)
  }

  /**
   * Get the [[AccountPosition]] [[PublicKey]] and sends a transaction to
   * create it if it doesn't exist.
   *
   * ## Remarks
   *
   * It is recommended to use other functions to register specfic position types. e.g. using [[Pool]].withRegisterDepositPosition
   *
   * In web apps it's recommended to call `withGetOrCreatePosition` as part of a larger
   * transaction to prompt for a wallet signature less often.
   *
   * ## Example
   *
   * ```ts
   * // Load margin pools
   * const poolManager = new PoolManager(programs, provider)
   * const pools = await poolManager.loadAll()
   *
   * const depositNote = pools["SOL"].addresses.depositNoteMint
   * await marginAccount.getOrRegisterPosition(depositNote)
   * ```
   *
   * @param {Address} tokenMint
   * @return {Promise<PublicKey>}
   * @memberof MarginAccount
   */
  async getOrRegisterPosition(tokenMint: Address): Promise<PublicKey> {
    assert(this.info)
    const tokenMintAddress = translateAddress(tokenMint)
    for (let i = 0; i < this.positions.length; i++) {
      const position = this.positions[i]
      if (position.token.equals(tokenMintAddress)) {
        return position.address
      }
    }
    await this.registerPosition(tokenMintAddress)
    // Indirectly relying on new values if the position gets created,
    // so safe to use empty values
    await this.refresh({
      openPositions: [],
      openOrders: []
    })
    for (let i = 0; i < this.positions.length; i++) {
      const position = this.positions[i]
      if (position.token.equals(tokenMintAddress)) {
        return position.address
      }
    }
    throw new Error("Unable to register position.")
  }

  /**
   * Get the [[AccountPosition]] [[PublicKey]] and appends an instructon to
   * create it if it doesn't exist.
   *
   * ## Remarks
   *
   * It is recommended to use other functions to register specfic position types. e.g. using [[Pool]].withRegisterDepositPosition
   *
   * ## Example
   *
   * ```ts
   * // Load margin pools
   * const poolManager = new PoolManager(programs, provider)
   * const pools = await poolManager.loadAll()
   *
   * // Register position
   * const positionTokenMint = pools["SOL"].addresses.depositNoteMint
   * const instructions: TransactionInstruction[] = []
   * await marginAccount.withGetOrRegisterPosition({ instructions, positionTokenMint })
   * await marginAccount.sendAndConfirm(instructions)
   * ```
   *
   * @param args
   * @param {TransactionInstruction[]} args.instructions The instructions to append to
   * @param {Address} args.positionTokenMint The position mint to register a position for
   * @return {PublicKey}
   * @memberof MarginAccount
   */
  async withGetOrRegisterPosition({
    instructions,
    positionTokenMint
  }: {
    instructions: TransactionInstruction[]
    positionTokenMint: Address
  }): Promise<PublicKey> {
    const tokenMintAddress = translateAddress(positionTokenMint)
    const position = this.getPositionNullable(tokenMintAddress)
    if (position) {
      return position.address
    }
    return await this.withRegisterPosition({ instructions, positionTokenMint: tokenMintAddress })
  }

  /**
   * Sends a transaction to register an [[AccountPosition]] for the mint. When registering a [[Pool]] position,
   * the mint would not be Bitcoin or SOL, but rather the `depositNoteMint` or `loanNoteMint` found in `pool.addresses`.
   * A margin account has a limited capacity of positions.
   *
   * ## Remarks
   *
   * It is recommended to use other functions to register specfic position types. e.g. using [[Pool]].withRegisterDepositPosition
   *
   * In web apps it's is recommended to use `withRegisterPosition` as part of a larget transaction
   * to prompt for a wallet signature less often.
   *
   * ## Example
   *
   * ```ts
   * // Load the pools
   * const poolManager = new PoolManager(programs, provider)
   * const pools = await poolManager.loadAll()
   *
   * // Register the SOL deposit position
   * const depositNoteMint = pools["SOL"].addresses.depositNoteMint
   * await marginAccount.registerPosition(depositNoteMint)
   * ```
   *
   * @param {Address} tokenMint
   * @return {Promise<TransactionSignature>}
   * @memberof MarginAccount
   */
  async registerPosition(tokenMint: Address): Promise<TransactionSignature> {
    const positionTokenMint = translateAddress(tokenMint)
    const instructions: TransactionInstruction[] = []
    await this.withRegisterPosition({ instructions, positionTokenMint })
    return await this.sendAndConfirm(instructions)
  }

  /**
   * Get instruction to register new position
   *
   * ## Remarks
   *
   * It is recommended to use other functions to register specfic position types. e.g. using [[Pool]].withRegisterDepositPosition
   *
   * ## Example
   *
   * ```ts
   * // Load the pools
   * const poolManager = new PoolManager(programs, provider)
   * const pools = await poolManager.loadAll()
   *
   * // Register the SOL deposit position
   * const positionTokenMint = pools["SOL"].addresses.depositNoteMint
   * const instructions: TransactionInstruction[] = []
   * const position = await marginAccount.withRegisterPosition({ instructions, positionTokenMint })
   * await marginAccount.sendAndConfirm(instructions)
   * ```
   *
   * @param args
   * @param {TransactionInstruction[]} args.instructions Instructions array to append to.
   * @param {Address} args.positionTokenMint The mint for the relevant token for the position
   * @return {Promise<PublicKey>} Returns the instruction, and the address of the token account to be created for the position.
   * @memberof MarginAccount
   */
  async withRegisterPosition({
    instructions,
    positionTokenMint
  }: {
    instructions: TransactionInstruction[]
    positionTokenMint: Address
  }): Promise<PublicKey> {
    const tokenAccount = this.findPositionTokenAddress(positionTokenMint)
    const config = this.findTokenConfigAddress(positionTokenMint)

    const ix = await this.programs.margin.methods
      .registerPosition()
      .accounts({
        authority: this.owner,
        payer: this.provider.wallet.publicKey,
        marginAccount: this.address,
        positionTokenMint: positionTokenMint,
        config,
        tokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      })
      .instruction()
    instructions.push(ix)
    return tokenAccount
  }

  /**
   * Get instruction to create a new deposit position
   *
   * ## Remarks
   *
   * A deposit position are tokens deposited directly into a margin account, without the use
   * of any other programs (like pools).
   *
   * @param args
   * @param {TransactionInstruction[]} args.instructions Instructions array to append to.
   * @param {Address} args.tokenMint The mint for the relevant token for the position
   * @return {Promise<PublicKey>} Returns the address of the token account to be created for the position.
   */
  async withCreateDepositPosition({
    instructions,
    tokenMint
  }: {
    instructions: TransactionInstruction[]
    tokenMint: Address
  }): Promise<PublicKey> {
    const tokenAccount = AssociatedToken.derive(tokenMint, this.address)
    const tokenConfig = this.findTokenConfigAddress(tokenMint)

    const ix = await this.programs.margin.methods
      .createDepositPosition()
      .accounts({
        authority: this.owner,
        payer: this.provider.wallet.publicKey,
        marginAccount: this.address,
        mint: tokenMint,
        config: tokenConfig,
        tokenAccount,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      })
      .instruction()

    instructions.push(ix)
    return tokenAccount
  }

  /**
   * Send a transaction to close the [[MarginAccount]] and return rent to the owner.
   * All positions must have a zero balance and be closed first.
   *
   * ## Example
   *
   * ```ts
   * // Close all positions. A non zero balance results in an error
   * for (const position of marginAccount.getPositions()) {
   *   await marginAccount.closePosition(position)
   * }
   *
   * // Close the account and send the transaction
   * await marginAccount.closeAccount()
   * ```
   *
   * @memberof MarginAccount
   */
  async closeAccount() {
    const ix: TransactionInstruction[] = []
    await this.withCloseAccount(ix)
    await this.sendAndConfirm(ix)
  }

  /**
   * Create an instruction to close the [[MarginAccount]] and return rent to the owner.
   * All positions must have a zero balance and be closed first.
   *
   * ## Example
   *
   * ```ts
   * const instructions: TransactionInstruction[] = []
   *
   * // Close all positions. A non zero balance results in an error
   * for (const position of marginAccount.getPositions()) {
   *   await marginAccount.withClosePosition(instructions, position)
   * }
   *
   * // Close the account and send the transaction
   * await marginAccount.withCloseAccount(instructions)
   * await marginAccount.sendAndConfirm(instructions)
   * ```
   *
   * @param {TransactionInstruction[]} instructions
   * @returns {Promise<void>}
   * @memberof MarginAccount
   */
  async withCloseAccount(instructions: TransactionInstruction[]): Promise<void> {
    for (const position of this.getPositions()) {
      await this.withClosePosition(instructions, position)
    }
    const ix = await this.programs.margin.methods
      .closeAccount()
      .accounts({
        owner: this.owner,
        receiver: this.provider.wallet.publicKey,
        marginAccount: this.address
      })
      .instruction()
    instructions.push(ix)
  }

  /**
   * Send a transaction to close a position. A non-zero balance will result in a transaction error.
   * There is a limited capacity for positions so it is recommended to close positions that
   * are no longer needed.
   *
   * ## Example
   *
   * ```ts
   * // Load the pools
   * const poolManager = new PoolManager(programs, provider)
   * const pools = await poolManager.loadAll()
   *
   * // Get the SOL position
   * const depositNoteMint = pools["SOL"].addresses.depositNoteMint
   * const position = marginAccount.getPosition(depositNoteMint)
   *
   * await marginAccount.closePosition(position)
   * ```
   *
   * @param {AccountPosition} position
   * @return {Promise<void>}
   * @memberof MarginAccount
   */
  async closePosition(position: AccountPosition): Promise<void> {
    const ix: TransactionInstruction[] = []
    await this.withClosePosition(ix, position)
    await this.sendAndConfirm(ix)
  }

  /**
   * Create an instruction to close a position. A non-zero balance will result in a transaction error.
   * There is a limited capacity for positions so it is recommended to close positions that
   * are no longer needed.
   *
   * ## Example
   *
   * ```ts
   * // Load the pools
   * const poolManager = new PoolManager(programs, provider)
   * const pools = await poolManager.loadAll()
   *
   * // Get the SOL position
   * const depositNoteMint = pools["SOL"].addresses.depositNoteMint
   * const position = marginAccount.getPosition(depositNoteMint)
   *
   * const instructions: TransactionInstruction[] = []
   * await marginAccount.closePosition(instructions, position)
   * await marginAccount.sendAndConfirm(instructions)
   * ```
   *
   * @param {TransactionInstruction[]} instructions
   * @param {AccountPosition} position
   * @return {Promise<void>}
   * @memberof MarginAccount
   */
  async withClosePosition(instructions: TransactionInstruction[], position: AccountPosition): Promise<void> {
    const ix = await this.programs.margin.methods
      .closePosition()
      .accounts({
        authority: this.owner,
        receiver: this.provider.wallet.publicKey,
        marginAccount: this.address,
        positionTokenMint: position.token,
        tokenAccount: position.address,
        tokenProgram: TOKEN_PROGRAM_ID
      })
      .instruction()
    instructions.push(ix)
  }

  /** @deprecated This has been renamed to `liquidateEnd` and will be removed in a future release. */
  async stopLiquidation(): Promise<string> {
    return await this.liquidateEnd()
  }

  /**
   * Get instruction to end a liquidation
   * @deprecated This has been renamed to `withLiquidateEnd` and will be removed in a future release. */
  async withStopLiquidation(instructions: TransactionInstruction[]): Promise<void> {
    return await this.withLiquidateEnd(instructions)
  }

  /**
   * Send a transaction to end a liquidation.
   *
   * ## Remarks
   *
   * The [[MarginAccount]] can enter liquidation while it's `riskIndicator` is at or above 1.0.
   * Liquidation is in progress when `isBeingLiquidated` returns true.
   * Liquidation can only end when enough collateral is deposited or enough collateral is liquidated to lower `riskIndicator` sufficiently.
   *
   * @return {Promise<string>}
   * @memberof MarginAccount
   */
  async liquidateEnd(): Promise<string> {
    const ix: TransactionInstruction[] = []
    await this.withLiquidateEnd(ix)
    return await this.sendAndConfirm(ix)
  }

  /**
   * Get instruction to end a liquidation
   *
   * ## Remarks
   *
   * The [[MarginAccount]] can enter liquidation while it's `riskIndicator` is at or above 1.0.
   * Liquidation is in progress when `isBeingLiquidated` returns true.
   *
   * ## Authority
   *
   * The [[MarginAccount]].`provider`.`wallet` will be used as the authority for the transaction.
   * The liquidator may end the liquidation at any time.
   * The margin account owner may end the liquidation only when at least one condition is true:
   * 1) When enough collateral is deposited or enough collateral is liquidated to lower `riskIndicator` sufficiently.
   * 2) When the liquidation has timed out when [[MarginAccount]]`.getRemainingLiquidationTime()` is negative
   *
   * @param {TransactionInstruction[]} instructions The instructions to append to
   * @return {Promise<void>}
   * @memberof MarginAccount
   */
  async withLiquidateEnd(instructions: TransactionInstruction[]): Promise<void> {
    const liquidation = this.findLiquidationStateAddress()
    const authority = this.provider.wallet.publicKey
    assert(liquidation)
    assert(authority)
    const ix = await this.programs.margin.methods
      .liquidateEnd()
      .accounts({
        authority,
        marginAccount: this.address,
        liquidation
      })
      .instruction()
    instructions.push(ix)
  }

  /**
   * Get the time remaining on a liquidation until timeout in seconds.
   *
   * ## Remarks
   *
   * If `getRemainingLiquidationTime` is a negative number then `liquidationEnd` can be called
   * by the margin account owner regardless of the current margin account health.
   *
   * @return {number | undefined}
   * @memberof MarginAccount
   */
  getRemainingLiquidationTime(): number | undefined {
    const startTime = this.info?.liquidationData?.startTime?.toNumber()
    if (startTime === undefined) {
      return undefined
    }

    const timeoutConstant = this.programs.margin.idl.constants.find(constant => constant.name === "LIQUIDATION_TIMEOUT")
    assert(timeoutConstant)

    const now = Date.now() / 1000
    const elapsed = startTime - now
    const timeout = parseFloat(timeoutConstant.value)
    const remaining = timeout - elapsed
    return remaining
  }

  /**
   * Create an instruction that performs an action by invoking other adapter programs, allowing them to alter
   * the balances of the token accounts belonging to this margin account. The transaction fails if the [[MarginAccount]]
   * does not have sufficent collateral.
   *
   * ## Remarks
   *
   * This instruction is not invoked directly, but rather internally for example by [[Pool]] when depositing.
   *
   * @param {{
   *     instructions: TransactionInstruction[]
   *     adapterInstruction: TransactionInstruction
   *   }} {
   *     instructions,
   *     adapterInstruction
   *   }
   * @return {Promise<void>}
   * @memberof MarginAccount
   */
  async withAdapterInvoke({
    instructions,
    adapterInstruction
  }: {
    instructions: TransactionInstruction[]
    adapterInstruction: TransactionInstruction
  }): Promise<void> {
    const ix = await this.programs.margin.methods
      .adapterInvoke(adapterInstruction.data)
      .accounts({
        owner: this.owner,
        marginAccount: this.address,
        adapterProgram: adapterInstruction.programId,
        adapterConfig: findDerivedAccount(
          this.programs.margin.programId,
          "adapter-config",
          this.airspace,
          adapterInstruction.programId
        )
      })
      .remainingAccounts(this.invokeAccounts(adapterInstruction))
      .instruction()
    instructions.push(ix)
  }

  /**
   * Create an instruction to perform an action by invoking other adapter programs, allowing them only to
   * refresh the state of the margin account to be consistent with the actual
   * underlying prices or positions, but not permitting new position changes.
   *
   * ## Remarks
   *
   * This instruction is not invoked directly, but rather internally for example by [[Pool]] when depositing.
   * Accounting invoke is necessary when several position values have to be refreshed but in the interim there
   * aren't enough fresh positions to satisfy margin requirements.
   *
   * @param {{
   *     instructions: TransactionInstruction[]
   *     adapterProgram: Address
   *     adapterMetadata: Address
   *     adapterInstruction: TransactionInstruction
   *   }} {
   *     instructions,
   *     adapterProgram,
   *     adapterMetadata,
   *     adapterInstruction
   *   }
   * @return {Promise<void>}
   * @memberof MarginAccount
   */
  async withAccountingInvoke({
    instructions,
    adapterInstruction
  }: {
    instructions: TransactionInstruction[]
    adapterProgram?: Address
    adapterMetadata?: Address
    adapterInstruction: TransactionInstruction
  }): Promise<void> {
    const ix = await this.programs.margin.methods
      .accountingInvoke(adapterInstruction.data)
      .accounts({
        marginAccount: this.address,
        adapterProgram: adapterInstruction.programId,
        adapterConfig: findDerivedAccount(
          this.programs.margin.programId,
          "adapter-config",
          this.airspace,
          adapterInstruction.programId
        )
      })
      .remainingAccounts(this.invokeAccounts(adapterInstruction))
      .instruction()
    instructions.push(ix)
  }

  /**
   * prepares arguments for `adapter_invoke`, `account_invoke`, or `liquidator_invoke`
   *
   * @return {AccountMeta[]} The instruction keys but the margin account is no longer a signer.
   * @memberof MarginAccount
   */
  private invokeAccounts(adapterInstruction: TransactionInstruction): AccountMeta[] {
    const accounts: AccountMeta[] = []
    for (const acc of adapterInstruction.keys) {
      let isSigner = acc.isSigner
      if (acc.pubkey.equals(this.address)) {
        isSigner = false
      }
      accounts.push({
        pubkey: acc.pubkey,
        isSigner: isSigner,
        isWritable: acc.isWritable
      })
    }

    return accounts
  }

  /** Create an address lookup table registry account owned by the margin account.
   */
  async initLookupRegistry(): Promise<void> {
    const ix: TransactionInstruction[] = []
    await this.withInitLookupRegistry(ix)
    await this.sendAndConfirm(ix)
  }

  async withInitLookupRegistry(instructions: TransactionInstruction[]) {
    const [registryAccount] = PublicKey.findProgramAddressSync([this.address.toBytes()], LOOKUP_REGISTRY_PROGRAM)
    const exists = await this.provider.connection.getAccountInfo(registryAccount)
    if (!exists) {
      const ix = await this.programs.margin.methods
        .initLookupRegistry()
        .accounts({
          marginAuthority: this.owner,
          payer: this.provider.wallet.publicKey,
          marginAccount: this.address,
          registryAccount,
          registryProgram: LOOKUP_REGISTRY_PROGRAM,
          systemProgram: SystemProgram.programId
        })
        .instruction()
      instructions.push(ix)
    }
  }

  async createLookupTable(slot: number, discriminator: number): Promise<PublicKey> {
    const ix: TransactionInstruction[] = []
    const lookupTable = await this.withCreateLookupTable({ instructions: ix, slot, discriminator })
    await this.sendAndConfirm(ix)
    return lookupTable
  }

  async withCreateLookupTable({
    instructions,
    slot,
    discriminator
  }: {
    instructions: TransactionInstruction[]
    slot: number
    discriminator: number
  }): Promise<PublicKey> {
    const [registryAccount] = PublicKey.findProgramAddressSync([this.address.toBytes()], LOOKUP_REGISTRY_PROGRAM)
    const [_, lookupTable] = AddressLookupTableProgram.createLookupTable({
      authority: this.address,
      payer: this.provider.wallet.publicKey,
      recentSlot: slot
    })
    const ix = await this.programs.margin.methods
      .createLookupTable(new BN(slot), new BN(discriminator))
      .accounts({
        marginAuthority: this.owner,
        payer: this.provider.wallet.publicKey,
        marginAccount: this.address,
        registryAccount,
        registryProgram: LOOKUP_REGISTRY_PROGRAM,
        systemProgram: SystemProgram.programId,
        lookupTable,
        addressLookupTableProgram: AddressLookupTableProgram.programId
      })
      .instruction()
    instructions.push(ix)
    return lookupTable
  }

  async appendToLookupTable(args: { lookupTable: PublicKey; discriminator: number; addresses: PublicKey[] }) {
    const ix: TransactionInstruction[] = []
    await this.withAppendToLookupTable({ instructions: ix, ...args })
    await this.sendAndConfirm(ix)
  }

  async withAppendToLookupTable({
    instructions,
    lookupTable,
    discriminator,
    addresses
  }: {
    instructions: TransactionInstruction[]
    lookupTable: PublicKey
    discriminator: number
    addresses: PublicKey[]
  }) {
    const [registryAccount] = PublicKey.findProgramAddressSync([this.address.toBytes()], LOOKUP_REGISTRY_PROGRAM)
    const ix = await this.programs.margin.methods
      .appendToLookup(new BN(discriminator), addresses)
      .accounts({
        marginAuthority: this.owner,
        payer: this.provider.wallet.publicKey,
        marginAccount: this.address,
        registryAccount,
        registryProgram: LOOKUP_REGISTRY_PROGRAM,
        systemProgram: SystemProgram.programId,
        lookupTable,
        addressLookupTableProgram: AddressLookupTableProgram.programId
      })
      .instruction()
    instructions.push(ix)
  }

  /**
   * Sends a transaction using the [[MarginAccount]] [[AnchorProvider]]
   *
   * @param {TransactionInstruction[]} instructions
   * @param {Signer[]} [signers]
   * @return {Promise<string>}
   * @memberof MarginAccount
   */
  async sendAndConfirm(instructions: TransactionInstruction[], signers?: Signer[]): Promise<string> {
    return await sendAndConfirm(this.provider, instructions, signers)
  }

  async sendAndConfirmV0(
    instructions: TransactionInstruction[][],
    lookupTables: { address: string; data: Uint8Array }[],
    signers?: Signer[]
  ): Promise<string> {
    return await sendAndConfirmV0(this.provider, instructions, lookupTables, signers)
  }

  /**
   * Sends a collection of transactions using the [[MarginAccount]] [[AnchorProvider]].
   *
   * ## Remarks
   *
   * This function has 2 additional features compared to `sendAll` from web3.js or anchor.
   * - Logging a [[Transaction]] error will include [[Transaction]] logs.
   * - If an [[Transaction]] array element is itself a `TransactionInstruction[][]` this function will send those transactions in parallel.
   *
   * @param {((TransactionInstruction[] | TransactionInstruction[][])[])} transactions
   * @return {Promise<string>}
   * @memberof MarginAccount
   */
  async sendAll(transactions: (TransactionInstruction[] | TransactionInstruction[][])[]): Promise<string> {
    return await sendAll(this.provider, transactions)
  }

  /**
   * Create instructions to refresh [[MarginAccount]] pool positions in a prioritised manner so that additional
   * borrows or withdraws can occur.
   *
   * @param {({
   *     instructions: TransactionInstruction[]
   *     pools: Record<any, Pool> | Pool[]
   *     marginAccount: MarginAccount
   *     markets: FixedTermMarket[]
   *     marketAddresstoCreate?: PublicKey
   *   })} {
   *     instructions,
   *     pools,
   *     marginAccount
   *   }
   * @return {Promise<void>}
   * @memberof Pool
   */
  async withPrioritisedPositionRefresh({
    instructions,
    pools,
    markets,
    marketAddress
  }: {
    instructions: TransactionInstruction[]
    pools: Record<any, Pool> | Pool[]
    markets: FixedTermMarket[]
    marketAddress?: PublicKey
  }): Promise<void> {
    const poolsToRefresh: Pool[] = []
    for (const pool of Object.values(pools)) {
      const assetCollateralWeight = pool.depositNoteMetadata.valueModifier
      const depositPosition = this.getPositionNullable(pool.addresses.depositNoteMint)
      const borrowPosition = this.getPositionNullable(pool.addresses.loanNoteMint)
      if (pool.address === this.address) {
        poolsToRefresh.push(pool)
      } else if (borrowPosition && !borrowPosition.balance.eqn(0)) {
        poolsToRefresh.push(pool)
      } else if (assetCollateralWeight > 0 && depositPosition && !depositPosition.balance.eqn(0)) {
        poolsToRefresh.push(pool)
      }
    }
    for (const pool of poolsToRefresh) {
      await pool.withMarginRefreshPositionPrice({ instructions, marginAccount: this })
    }
    await refreshAllMarkets(markets, instructions, this, marketAddress)
  }

  /**
   * Refresh any deposit position
   *
   * @param {({
   *     instructions: TransactionInstruction[]
   *     config: Address
   *     priceOracle: PublicKey
   *   })} {
   *     instructions,
   *     pools,
   *     marginAccount
   *   }
   * @return {Promise<void>}
   */
  async withRefreshDepositPosition({
    instructions,
    config,
    priceOracle
  }: {
    instructions: TransactionInstruction[]
    config: Address
    priceOracle: Address
  }): Promise<void> {
    const ix = await this.programs.margin.methods
      .refreshDepositPosition()
      .accounts({
        marginAccount: this.address,
        config,
        priceOracle
      })
      .instruction()
    instructions.push(ix)
  }

  // Helper to extract fixed term orders for a margin account
  extractFixedTermOrders(
    orders: Record<string, OpenOrders>
  ): OpenOrders[] {
    return Object.values(orders).filter(order => order.authority === this.address.toBase58())
  }

  // Helper to extract fixed term positions for a margin account
  extractFixedTermPositions(
    positions: Record<string, OpenPositions>
  ): OpenPositions[] {
    return Object.values(positions).filter(position => position.authority === this.address.toBase58())
  }
}

