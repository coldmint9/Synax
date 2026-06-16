export type GoalMorph = 'bar' | 'mini' | 'pill-input' | 'pill-expanded'

export function goalDockStateToMorph(
  state: 'idle' | 'prompt' | 'input' | 'working' | 'expanded',
): GoalMorph {
  switch (state) {
    case 'prompt':
    case 'working': return 'mini'
    case 'input': return 'pill-input'
    case 'expanded': return 'pill-expanded'
    default: return 'bar'
  }
}
