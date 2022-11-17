import Title from 'antd/lib/typography/Title';
import { useRecoilState, useRecoilValue } from 'recoil';
import { ReorderArrows } from '@components/misc/ReorderArrows';
import { FixedBorrowRowOrder, FixedLendRowOrder } from '@state/views/fixed-term';
import { ResponsiveLineChart } from '@components/fixed-term/shared/charts/line-chart';
import {
  AllFixedMarketsAtom,
  AllFixedMarketsOrderBooksAtom,
  CurrentOrderTab,
  CurrentOrderTabAtom,
  FixedMarketAtom,
  MarketAndconfig,
  SelectedFixedMarketAtom
} from '@state/fixed-market/fixed-term-market-sync';
import { friendlyMarketName } from '@utils/jet/fixed-term-utils';
import { useMemo } from 'react';
import { calculate_implied_price, price_to_rate } from '@jet-lab/jet-bonds-client';
import { MainConfig } from '@state/config/marginConfig';
interface FixedChart {
  type: 'bids' | 'asks';
}

const getChartTitle = (currentTab: CurrentOrderTab, market: MarketAndconfig) => {
  if (!market?.config?.symbol) return '';
  switch (currentTab) {
    case 'borrow-now':
      return `${friendlyMarketName(market.config.symbol, market.config.borrowDuration)} loan offers`;
    case 'lend-now':
      return `${friendlyMarketName(market.config.symbol, market.config.borrowDuration)} borrow requests`;
    case 'offer-loan':
      return `${market.config.symbol} loan offers`;
    case 'request-loan':
      return `${market.config.symbol} borrow requests`;
  }
};

const asksKeys = ['lend-now', 'request-loan'];
const immediateKeys = ['lend-now', 'borrow-now'];

export const FixedPriceChartContainer = ({ type }: FixedChart) => {
  const [rowOrder, setRowOrder] = useRecoilState(type === 'asks' ? FixedLendRowOrder : FixedBorrowRowOrder);
  const currentTab = useRecoilValue(CurrentOrderTabAtom);
  const selectedMarketIndex = useRecoilValue(SelectedFixedMarketAtom);
  const market = useRecoilValue(FixedMarketAtom);
  const allMarkets = useRecoilValue(AllFixedMarketsAtom);
  const openOrders = useRecoilValue(AllFixedMarketsOrderBooksAtom);
  const marginConfig = useRecoilValue(MainConfig);

  const token = useMemo(() => {
    if (!marginConfig || !market) return null;
    return Object.values(marginConfig?.tokens).find(token => {
      return market.config.underlyingTokenMint === token.mint.toString();
    });
  }, [marginConfig, market?.config]);

  const decimals = useMemo(() => {
    if (!token) return null;
    if (!marginConfig || !market?.config) return 6;
    return token.decimals;
  }, [token]);

  const series = useMemo(() => {
    let target = openOrders;
    // If market order we display only the currently selected market
    if (immediateKeys.includes(currentTab)) {
      target = [openOrders[selectedMarketIndex]];
    }

    const orderTypeKey = asksKeys.includes(currentTab) ? 'asks' : 'bids';
    return target.reduce((all, current) => {
      if (current[orderTypeKey].length === 0) {
        all.push({
          id: current.name,
          type: orderTypeKey,
          data: []
        });
        return all;
      }
      const currentMarketConfig = allMarkets.find(market => market.name === current.name)?.config;
      let cumulativeQuote = BigInt(0);
      let cumulativeBase = BigInt(0);
      const data: Array<{ x: number; y: number }> = [];
      current[orderTypeKey].map(order => {
        cumulativeQuote += order.quote_size;
        cumulativeBase += order.base_size;
        const price = calculate_implied_price(cumulativeBase, cumulativeQuote);
        const rate = Number(price_to_rate(price, BigInt(currentMarketConfig.borrowDuration))) / 100;
        data.push({
          x: Number(cumulativeQuote / BigInt(10 ** decimals)),
          y: rate
        });
      });
      if (immediateKeys.includes(currentTab)) {
        const y = data[0].y;
        data.unshift({
          x: 0,
          y
        });
      }
      const currentSeries = {
        id: current.name,
        type: orderTypeKey,
        data
      };
      all.push(currentSeries);
      return all;
    }, []);
  }, [openOrders, currentTab, selectedMarketIndex]);

  return (
    <div className="fixed-term-graph view-element view-element-hidden flex align-center justify-end column">
      <div className="fixed-term-graph-head view-element-item view-element-item-hidden flex justify-center column">
        <div className="fixed-term-graph-head-info flex align-end">
          <div className="flex-centered">
            <Title level={2}>{getChartTitle(currentTab, market)}</Title>
          </div>
        </div>
      </div>
      <ResponsiveLineChart series={series} />
      <ReorderArrows component="fixedChart" order={rowOrder} setOrder={setRowOrder} />
    </div>
  );
};