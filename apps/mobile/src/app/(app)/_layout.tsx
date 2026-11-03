import { NativeTabs } from 'expo-router/native-tabs';

export default function AppTabs() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} md="home" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="markets">
        <NativeTabs.Trigger.Label>Markets</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="chart.line.uptrend.xyaxis" md="trending_up" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="portfolio">
        <NativeTabs.Trigger.Label>Portfolio</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'chart.pie', selected: 'chart.pie.fill' }} md="pie_chart" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="banking">
        <NativeTabs.Trigger.Label>Banking</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'building.columns', selected: 'building.columns.fill' }} md="account_balance" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
