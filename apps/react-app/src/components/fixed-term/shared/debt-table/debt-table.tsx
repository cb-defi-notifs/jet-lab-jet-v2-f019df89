import { useRecoilState, useRecoilValue } from 'recoil';
import { AccountsViewOrder } from '@state/views/views';
import { CurrentAccount } from '@state/user/accounts';
import { Tabs } from 'antd';
import { ReorderArrows } from '@components/misc/ReorderArrows';
import { ConnectionFeedback } from '@components/misc/ConnectionFeedback/ConnectionFeedback';
import { LoadingOutlined } from '@ant-design/icons';
import { useOrdersForUser } from '@jet-lab/store';
import { AllFixedTermMarketsAtom, SelectedFixedTermMarketAtom } from '@state/fixed-term/fixed-term-market-sync';
import { useEffect, useMemo } from 'react';
import { notify } from '@utils/notify';
import { useProvider } from '@utils/jet/provider';
import { BlockExplorer, Cluster } from '@state/settings/settings';
import { OrdersTable } from './posted-order-table';
import { TokenAmount } from '@jet-lab/margin';
import BN from 'bn.js';
import numeral from 'numeral'
import { useOpenPositions } from '@jet-lab/store/dist/api';
import { OpenBorrowsTable } from './open-borrows-table';

interface ITabLink {
  name: string
  amount: number
  decimals: number
}
const TabLink = ({ name, amount, decimals }: ITabLink) => {
  const formatted = useMemo(() => {
    const ta = new TokenAmount(new BN(amount), decimals)
    const num = numeral(ta.tokens)
    return num.format('0.0a')
  }, [amount])

  return <div className='tab-link'>{name}<span className='badge'>{formatted}</span></div>
}

export function DebtTable(): JSX.Element {
  const [accountsViewOrder, setAccountsViewOrder] = useRecoilState(AccountsViewOrder);
  const account = useRecoilValue(CurrentAccount);
  const markets = useRecoilValue(AllFixedTermMarketsAtom);
  const selectedMarket = useRecoilValue(SelectedFixedTermMarketAtom);
  const market = markets[selectedMarket];
  const { provider } = useProvider();
  const blockExplorer = useRecoilValue(BlockExplorer);
  const cluster = useRecoilValue(Cluster);

  const { data: ordersData, error: ordersError, isLoading: ordersLoading } = useOrdersForUser(market?.market, account);
  const { data: positionsData, error: positionsError, isLoading: positionsLoading } = useOpenPositions(market?.market, account);

  useEffect(() => {
    if (ordersError || positionsError)
      notify(
        'Error fetching data',
        'There was an unexpected error fetching your orders data, please try again soon',
        'error'
      );
  }, [ordersError, positionsError]);

  return (
    <div className="debt-detail account-table view-element flex-centered">
      <ConnectionFeedback />
      {ordersData && positionsData && market && <Tabs
        defaultActiveKey="open-orders"
        destroyInactiveTabPane={true}
        items={[
          {
            label: <TabLink name="Loan Offers" amount={ordersData.unfilled_lend} decimals={markets[selectedMarket].token.decimals} />,
            key: 'loan-offers',
            children:
              ordersLoading || !account ? (
                <LoadingOutlined />
              ) : (
                <OrdersTable
                  data={ordersData?.open_orders.filter(o => o.is_lend_order) || []}
                  provider={provider}
                  market={markets[selectedMarket]}
                  marginAccount={account}
                  cluster={cluster}
                  blockExplorer={blockExplorer}
                />
              )
          },
          {
            label: <TabLink name="Borrow Requests" amount={ordersData.unfilled_borrow} decimals={markets[selectedMarket].token.decimals} />,
            key: 'borrow-requests',
            children:
              ordersLoading || !account ? (
                <LoadingOutlined />
              ) : (
                <OrdersTable
                  data={ordersData?.open_orders.filter(o => !o.is_lend_order) || []}
                  provider={provider}
                  market={markets[selectedMarket]}
                  marginAccount={account}
                  cluster={cluster}
                  blockExplorer={blockExplorer}
                />
              )
          },
          {
            label: <TabLink name="Open Borrows" amount={positionsData?.total_borrowed} decimals={markets[selectedMarket].token.decimals} />,
            key: 'open-borrows',
            children: positionsLoading ? <LoadingOutlined /> : <OpenBorrowsTable data={positionsData.loans}  market={markets[selectedMarket]}/>
          }
        ]}
        size='large'
      />}
      <ReorderArrows component="debtTable" order={accountsViewOrder} setOrder={setAccountsViewOrder} vertical />
    </div>
  );
}