import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GroupedModelList, type ModelListGroup } from './GroupedModelList';
import { PopoverAnchorContext } from './ui/Popover';

function catalogue(select: (provider: string, model: string) => void): ModelListGroup[] {
  return Array.from({ length: 10 }, (_, index) => ({
    id: String(index),
    name: `Provider ${index}`,
    models: Array.from({ length: 6 + index % 2 }, (_, model) => ({
      id: String(model),
      name: `Model ${model}`,
      suffix: <span>image</span>,
      select: () => select(String(index), String(model)),
    })),
  }));
}

describe('GroupedModelList', () => {
  it('browses one provider at a time and distinguishes identical model names and IDs', async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    const groups = catalogue(select);
    const props = { groups, selectedGroupId: '7', selectedModelId: '4', onDismiss: vi.fn() };
    const view = render(<GroupedModelList {...props} />);
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(9);
    const current = screen.getByRole('button', { current: true });
    expect(current.children[0]).toHaveTextContent('Model 4');
    expect(current.children[1].tagName.toLowerCase()).toBe('svg');
    expect(current.children[2]).toHaveTextContent('image');
    await user.click(screen.getByRole('button', { name: 'Provider 2' }));
    const header = screen.getByRole('button', { expanded: true });
    expect(header).toHaveTextContent('Provider 2');
    expect(screen.getByRole('button', { name: 'Provider 7 Model 4' })).toBeVisible();
    expect(screen.queryByRole('button', { current: true })).toBeNull();
    view.rerender(<GroupedModelList {...props} groups={[...groups]} />);
    expect(screen.getByRole('button', { expanded: true })).toBe(header);
    expect(select).not.toHaveBeenCalled();
    await user.click(screen.getByTitle('Model 4'));
    expect(select).toHaveBeenCalledExactlyOnceWith('2', '4');
  });

  it('collapses to provider headers until another group is opened or the menu is reopened', async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    const groups = catalogue(select);
    const props = { groups, selectedGroupId: '7', selectedModelId: '4', onDismiss: vi.fn() };
    const view = render(<GroupedModelList {...props} />);
    const currentHeader = screen.getByRole('button', { expanded: true });
    await user.click(currentHeader);
    expect(currentHeader).toHaveFocus();
    expect(currentHeader).toHaveAccessibleName('Provider 7 Model 4');
    view.rerender(<GroupedModelList {...props} groups={[...groups]} />);
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(10);
    expect(screen.queryByTitle('Model 4')).toBeNull();

    const other = screen.getByRole('button', { name: 'Provider 8' });
    other.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { expanded: true })).toBe(other);
    await user.keyboard(' ');
    expect(screen.queryByRole('button', { expanded: true })).toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(props.onDismiss).not.toHaveBeenCalled();

    view.unmount();
    render(<GroupedModelList {...props} />);
    expect(screen.getByRole('button', { expanded: true })).toHaveTextContent('Provider 7');
    expect(screen.getByRole('button', { current: true })).toHaveTextContent('Model 4');
  });

  it('keeps closing rows inert and preserves them when the same provider reopens mid-transition', async () => {
    const user = userEvent.setup();
    render(<GroupedModelList groups={catalogue(vi.fn())} selectedGroupId="0" onDismiss={vi.fn()} />);
    const header = screen.getByRole('button', { expanded: true });
    const panel = document.getElementById(header.getAttribute('aria-controls')!)!;
    const row = screen.getByTitle('Model 0');
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    Object.defineProperty(panel, 'getAnimations', { value: () => [{ finished }] });

    await user.click(header);
    expect(panel).toHaveAttribute('inert');
    expect(row).toBeInTheDocument();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Provider 1' })).toHaveFocus();

    await user.click(header);
    await act(async () => { finish(); });
    expect(panel).not.toHaveAttribute('inert');
    expect(screen.getByTitle('Model 0')).toBe(row);
  });

  it('recovers focus and forgets a browsed group that disappears on refresh', async () => {
    const user = userEvent.setup();
    const groups = catalogue(vi.fn());
    const trigger = document.createElement('button');
    const anchor = { current: trigger };
    const menu = (available: ModelListGroup[]) => (
      <PopoverAnchorContext.Provider value={anchor}>
        <GroupedModelList groups={available} selectedGroupId="4" selectedModelId="2" onDismiss={vi.fn()} />
      </PopoverAnchorContext.Provider>
    );
    const view = render(menu([]));
    view.rerender(menu(groups));
    expect(screen.getByRole('button', { current: true })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Provider 8' }));
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTitle('Model 0')).toHaveFocus();
    view.rerender(menu(groups.map(group => group.id === '8' ? { ...group, models: group.models.slice(1) } : group)));
    expect(screen.getByRole('button', { expanded: true })).toHaveFocus();
    view.rerender(menu(groups.filter(group => group.id !== '8')));
    expect(screen.getByRole('button', { current: true })).toHaveFocus();
    view.rerender(menu(groups));
    expect(screen.getByRole('button', { expanded: true })).toHaveTextContent('Provider 4');
  });

  it('keeps the check on follow while opening its inherited provider and supports keyboard selection', async () => {
    const user = userEvent.setup();
    const select = vi.fn();
    const dismiss = vi.fn();
    const follow = { name: 'Follow Agent', selected: true, select: vi.fn() };
    const groups = catalogue(select);
    render(<GroupedModelList groups={groups} preferredGroupId="3" follow={follow} onDismiss={dismiss} />);
    expect(screen.getByRole('button', { current: true })).toHaveTextContent('Follow Agent');
    expect(screen.getByRole('button', { expanded: true })).toHaveTextContent('Provider 3');
    const next = screen.getByRole('button', { name: 'Provider 6' });
    next.focus();
    await user.keyboard('{Enter}{ArrowDown}{Enter}');
    expect(select).toHaveBeenCalledExactlyOnceWith('6', '0');
    await user.keyboard('{Escape}');
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
