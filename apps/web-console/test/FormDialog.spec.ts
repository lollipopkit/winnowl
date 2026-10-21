import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Harness from './fixtures/FormDialogHarness.svelte';
import { initI18n } from '../src/lib/locale';

describe('FormDialog (approve-with-edit and other form actions)', () => {
  beforeAll(() => initI18n());
  afterEach(cleanup);

  it('prefills on open, keeps the form open with the error when submit fails, closes on success', async () => {
    const onopen = vi.fn();
    const onsubmit = vi.fn().mockRejectedValueOnce(new Error('409 transition_rejected')).mockResolvedValueOnce(undefined);
    render(Harness, { onsubmit, onopen });

    await fireEvent.click(screen.getByRole('button', { name: 'Open review' }));
    expect(onopen).toHaveBeenCalledTimes(1);
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled(); // canSubmit false until the field is filled

    await fireEvent.input(screen.getByLabelText('claim'), { target: { value: 'edited claim' } });
    await fireEvent.click(approve);
    expect(await screen.findByText(/409 transition_rejected/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument());
    expect(onsubmit).toHaveBeenCalledTimes(2);
  });
});
