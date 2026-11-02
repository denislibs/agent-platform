import { expect, test } from 'bun:test';
import { render, screen } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { cx } from '../src/index.ts';

test('cx joins truthy class names only', () => {
  expect(cx('ui-btn', false, 'ui-btn--sm', null, undefined, '')).toBe('ui-btn ui-btn--sm');
});

test('happy-dom and testing-library render Preact and drive the keyboard', async () => {
  const user = userEvent.setup();
  render(
    <div>
      <input aria-label="Name" />
      <button type="button">Save</button>
    </div>,
  );
  await user.tab();
  await user.keyboard('Ada');
  await user.tab();
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Ada');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
});

test('testing-library cleans the document between tests', () => {
  expect(document.body.innerHTML).toBe('');
});
