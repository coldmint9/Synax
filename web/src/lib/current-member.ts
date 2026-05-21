import { teamApi } from './api/team'

export async function loadCurrentMemberView(currentUserId: string, fallbackEmail: string) {
  const { members, roles } = await teamApi.listMembersAndRoles()
  const member =
    members.find(item => item.id === currentUserId) ??
    members.find(item => item.email.toLowerCase() === fallbackEmail.toLowerCase()) ??
    null

  if (!member) {
    return {
      member: null,
      role: null,
      projectCount: 0,
    }
  }

  const role = roles.find(item => item.key === member.platformRole) ?? null
  const projects = await teamApi.getMemberProjects(member.id)
  return {
    member,
    role,
    projectCount: projects.length,
  }
}

