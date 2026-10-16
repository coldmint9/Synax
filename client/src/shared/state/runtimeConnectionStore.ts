import { create } from 'zustand';
import type { RuntimeConnectionState } from '../../adapters/transport/rustRuntimeConnection';

interface Connections {
  sessions: Record<string, RuntimeConnectionState>;
  set: (id: string, state: RuntimeConnectionState) => void;
  remove: (id: string) => void;
}
export const useRuntimeConnectionStore = create<Connections>((set) => ({
  sessions: {},
  set: (id, state) => set(current => current.sessions[id] === state ? current : { sessions: { ...current.sessions, [id]: state } }),
  remove: id => set(current => {
    const sessions = { ...current.sessions };
    delete sessions[id];
    return { sessions };
  }),
}));
