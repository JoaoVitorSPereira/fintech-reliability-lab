import { render, screen } from '@testing-library/react-native';
import { ThemeProvider } from 'styled-components/native';
import { makeTheme } from '@/theme/theme';
import { QualityBadge } from '../market';

// Skia needs a native module that doesn't exist under Jest; charts aren't under test here.
jest.mock('../charts', () => ({ Sparkline: () => null }));

async function renderBadge(dataQuality: string, marketStatus = 'ALWAYS_OPEN') {
  return await render(
    <ThemeProvider theme={makeTheme('light')}>
      <QualityBadge quote={{ dataQuality, marketStatus } as never} />
    </ThemeProvider>,
  );
}

describe('QualityBadge', () => {
  it('shows the server label verbatim', async () => {
    await renderBadge('LIVE');
    expect(screen.getByText('LIVE')).toBeTruthy();
  });

  it('never presents a stale price as live, even when the market is closed', async () => {
    await renderBadge('STALE', 'CLOSED');
    expect(screen.getByText('STALE')).toBeTruthy();
    expect(screen.getByLabelText('Price data: stale')).toBeTruthy();
  });

  it('says CLOSED for a fresh price on a closed market', async () => {
    await renderBadge('DELAYED', 'CLOSED');
    expect(screen.getByText('CLOSED')).toBeTruthy();
  });
});
