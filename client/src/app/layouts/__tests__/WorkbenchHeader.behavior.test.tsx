import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { WorkbenchHeader } from '../WorkbenchHeader';
import { useTerminalStore } from '../../../features/terminal/terminalStore';
import { useShellStore, type ProjectSummary } from '../../../shared/state/shellStore';
import { useAgentSessionStore } from '../../../features/agent-workspace/state/agentSessionStore';

vi.mock('../../../shared/hooks/useLocale', () => ({ useLocale: () => ({locale:'en',t:(key:string)=>key}) }));
vi.mock('../../../features/agent-workspace/projectSessionBadges', () => ({ useProjectSessionBadges: () => ({ badges:{}, refresh: async()=>{} }) }));
vi.mock('../WorkbenchIsland', () => ({ WorkbenchIsland: ({children}:{children:(compact:boolean)=>ReactNode}) => children(false) }));
vi.mock('../IslandSurface', () => ({ IslandSurface: ({children}:{children:ReactNode}) => <div>{children}</div> }));
vi.mock('../ToolbarPill', () => ({ ToolbarPill: ({visible,children}:{visible:boolean;children:ReactNode}) => visible ? children : null }));
vi.mock('../useIslandPresence', () => ({ useIslandPresence: (open:boolean) => ({ref:()=>{},present:open}) }));
vi.mock('../IslandSelection', () => ({IslandSelection:({children}:{children:ReactNode})=><div>{children}</div>}));
const project = { id:'p',name:'Example',status:'healthy' } as ProjectSummary;
const base = { chromeMode:'global' as const,activePanel:'sessions' as const,onPanelToggle:vi.fn(),hasProject:true,projectName:'Example',currentProjectId:'p',projects:[project],onProjectSwitch:vi.fn(),onCreateProject:vi.fn(),onRemoveProject:vi.fn(async()=>{}) };
const wrapper = ({children}:{children:ReactNode}) => <MemoryRouter>{children}</MemoryRouter>;
beforeEach(()=>{useAgentSessionStore.setState(useAgentSessionStore.getInitialState());useTerminalStore.setState({open:false});useShellStore.setState(s=>({preferences:{...s.preferences,locale:'en'}}));});
afterEach(()=>{vi.clearAllMocks();useTerminalStore.setState(useTerminalStore.getInitialState());useShellStore.setState(useShellStore.getInitialState());});
async function openRemoval(user:ReturnType<typeof userEvent.setup>){await user.click(screen.getByRole('button',{name:'appSwitchProject'}));await user.click(await screen.findByRole('menuitem',{name:'appRemoveProject: Example'}));return screen.findByRole('dialog',{name:'appRemoveProject'});}

describe('workbench action state',()=>{
 it('keeps Settings selection independent from Terminal',()=>{
  useTerminalStore.setState({open:true});const view=render(<WorkbenchHeader {...base}/>,{wrapper});
  expect(screen.getByRole('button',{name:'appSettings'})).toHaveAttribute('aria-pressed','false');
  expect(screen.getByRole('button',{name:'Terminal'})).toHaveAttribute('aria-pressed','true');
  act(()=>useTerminalStore.setState({open:false}));view.rerender(<WorkbenchHeader {...base} activePanel="settings"/>);
  expect(screen.getByRole('button',{name:'appSettings'})).toHaveAttribute('aria-pressed','true');
  expect(screen.getByRole('button',{name:'Terminal'})).toHaveAttribute('aria-pressed','false');
 });
 it('protects a pending removal from Escape and outside click until it settles',async()=>{
  const user=userEvent.setup();let resolve!:()=>void;const remove=vi.fn(()=>new Promise<void>(r=>{resolve=r}));
  render(<WorkbenchHeader {...base} onRemoveProject={remove}/>,{wrapper});const dialog=await openRemoval(user);
  await user.click(within(dialog).getByRole('button',{name:'appConfirmRemove'}));expect(remove).toHaveBeenCalledExactlyOnceWith('p');
  await user.keyboard('{Escape}');expect(screen.getByRole('dialog')).toBe(dialog);
  await user.click(dialog.querySelector('.ui-dialog-viewport') as HTMLElement);expect(screen.getByRole('dialog')).toBe(dialog);
  expect(within(dialog).getByRole('button',{name:'appCancel'})).toBeDisabled();
  await act(async()=>resolve());await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
 });
 it('retains the confirmation and reports a rejected removal without an unhandled promise',async()=>{
  const user=userEvent.setup();const remove=vi.fn().mockRejectedValue(new Error('Removal failed'));
  render(<WorkbenchHeader {...base} onRemoveProject={remove}/>,{wrapper});const dialog=await openRemoval(user);
  await user.click(within(dialog).getByRole('button',{name:'appConfirmRemove'}));expect(await screen.findByRole('alert')).toHaveTextContent('Removal failed');
  expect(screen.getByRole('dialog')).toBe(dialog);expect(within(dialog).getByRole('button',{name:'appConfirmRemove'})).toBeEnabled();
 });
});
