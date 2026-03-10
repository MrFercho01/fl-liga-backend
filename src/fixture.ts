import type { FixtureRound, RegisteredTeam } from './data'

interface TeamSlot {
  id: string
  isBye: boolean
}

const BYE_TEAM_ID = 'BYE'

const rotateSlots = (slots: TeamSlot[]): TeamSlot[] => {
  if (slots.length <= 2) return slots

  const [fixed, ...rest] = slots
  if (!fixed || rest.length === 0) return slots

  const last = rest[rest.length - 1]
  if (!last) return slots

  const middle = rest.slice(0, rest.length - 1)
  return [fixed, last, ...middle]
}

export const generateFixture = (teams: RegisteredTeam[]): FixtureRound[] => {
  if (teams.length < 2) return []

  const hasOddTeams = teams.length % 2 !== 0
  const teamSlots: TeamSlot[] = teams.map((team) => ({ id: team.id, isBye: false }))

  if (hasOddTeams) {
    teamSlots.push({ id: BYE_TEAM_ID, isBye: true })
  }

  let currentSlots = [...teamSlots]
  const rounds = currentSlots.length - 1
  const fixture: FixtureRound[] = []

  for (let round = 1; round <= rounds; round += 1) {
    const matchesCount = currentSlots.length / 2
    const matches: FixtureRound['matches'] = []

    for (let index = 0; index < matchesCount; index += 1) {
      const home = currentSlots[index]
      const away = currentSlots[currentSlots.length - 1 - index]
      if (!home || !away) continue

      if (home.isBye && away.isBye) {
        continue
      }

      if (home.isBye || away.isBye) {
        const teamWithBye = home.isBye ? away : home
        matches.push({
          homeTeamId: teamWithBye.id,
          awayTeamId: null,
          hasBye: true,
        })
        continue
      }

      matches.push({
        homeTeamId: home.id,
        awayTeamId: away.id,
        hasBye: false,
      })
    }

    fixture.push({
      round,
      matches,
    })

    currentSlots = rotateSlots(currentSlots)
  }

  return fixture
}
