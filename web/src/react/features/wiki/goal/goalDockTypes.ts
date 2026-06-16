export type GoalMorph = 'bar' | 'mini' | 'pill-input' | 'pill-expanded'

export function goalDockStateToMorph(
  state: 'idle' | 'input' | 'working' | 'expanded',
): GoalMorph {
  switch (state) {
    case 'input': return 'pill-input'
    case 'working': return 'mini'
    case 'expanded': return 'pill-expanded'
    default: return 'bar'
  }
}
