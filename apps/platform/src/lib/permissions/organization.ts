import { createAccessControl } from 'better-auth/plugins/access'
import { defaultStatements, ownerAc } from 'better-auth/plugins/organization/access'

const statement = {
  ...defaultStatements,
  member: ['read', 'create', 'update', 'delete'],
  group: ['create', 'read', 'update', 'delete'],
  lesson: ['create', 'readSelf', 'readAll', 'update', 'delete'],
  student: ['create', 'read', 'update', 'delete'],
  payment: ['create', 'read', 'update', 'delete'],
  paycheck: ['create', 'createSelf', 'read', 'update', 'delete'],
  salary: ['readSelf', 'readAll'],
  managerSalary: ['create', 'read', 'update', 'delete'],

  rate: ['create', 'read', 'update', 'delete'],
  groupType: ['create', 'read', 'update', 'delete'],
  teacherGroup: ['create', 'read', 'update', 'delete'],
  teacherLesson: ['create', 'read', 'update', 'delete'],
  studentGroup: ['create', 'read', 'update', 'delete'],
  studentLesson: ['create', 'read', 'update', 'delete', 'selectWarned'],
  wallet: ['create', 'read', 'update', 'delete'],

  lessonStudentHistory: ['read', 'update'],

  role: ['read', 'create', 'update', 'delete'],
} as const

const ac = createAccessControl(statement)

const teacher = ac.newRole({
  group: ['read'],
  lesson: ['readSelf'],
  student: ['read'],
  payment: ['read'],
  paycheck: ['read', 'createSelf'],
  salary: ['readSelf'],
  managerSalary: ['read'],

  rate: ['read'],
  groupType: ['read'],
  teacherGroup: ['read'],
  studentGroup: ['read'],
  teacherLesson: ['read'],
  studentLesson: ['read', 'update'],
  wallet: ['read'],
})

const manager = ac.newRole({
  group: ['create', 'read', 'update', 'delete'],
  lesson: ['create', 'readSelf', 'readAll', 'update', 'delete'],
  student: ['create', 'read', 'update', 'delete'],
  payment: ['create', 'read', 'update', 'delete'],
  paycheck: ['create', 'read', 'update', 'delete'],
  member: ['read', 'create', 'update', 'delete'],
  salary: ['readSelf', 'readAll'],
  managerSalary: ['read'],

  rate: ['create', 'read', 'update', 'delete'],
  groupType: ['create', 'read', 'update', 'delete'],
  teacherGroup: ['create', 'read', 'update', 'delete'],
  studentGroup: ['create', 'read', 'update', 'delete'],
  teacherLesson: ['create', 'read', 'update', 'delete'],
  studentLesson: ['create', 'read', 'update', 'delete', 'selectWarned'],
  wallet: ['create', 'read', 'update', 'delete'],

  lessonStudentHistory: ['read', 'update'],
})

const owner = ac.newRole({
  ...ownerAc.statements,
  ...manager.statements,
  managerSalary: ['create', 'read', 'update', 'delete'],
  organization: ['update'],
})

export type OrganizationStatementKeys = keyof typeof statement
export type OrganizationAction<T extends OrganizationStatementKeys> = (typeof statement)[T][number]
export type OrganizationPermissionCheck = {
  [R in OrganizationStatementKeys]?: readonly OrganizationAction<R>[]
}

/** Полный каталог всех ресурсов и действий (для UI и валидации). */
export const statementCatalog = statement

/** Карта прав «всё разрешено» — используется для роли `owner`. */
export const fullPermission: OrganizationPermissionCheck = Object.fromEntries(
  Object.entries(statement).map(([key, actions]) => [key, [...actions]]),
) as OrganizationPermissionCheck

/**
 * Статические права системных ролей.
 * `owner` — источник истины (неизменяем). `manager`/`teacher` — дефолтные
 * шаблоны, которые владелец может переопределить строкой в `OrganizationRole`.
 */
export const staticRolePermissions: Record<OrganizationRole, OrganizationPermissionCheck> = {
  owner: fullPermission,
  manager: manager.statements as OrganizationPermissionCheck,
  teacher: teacher.statements as OrganizationPermissionCheck,
}

export type OrganizationRole = 'owner' | 'manager' | 'teacher'

/** Системные роли, определённые в коде. `owner` всегда неизменяем. */
export const SYSTEM_ROLES = ['owner', 'manager', 'teacher'] as const
/** Роли, которые нельзя редактировать или удалять из UI. */
export const IMMUTABLE_ROLES = ['owner'] as const

export const systemRoleLabels: Record<OrganizationRole, string> = {
  owner: 'Владелец',
  manager: 'Менеджер',
  teacher: 'Учитель',
}

/**
 * Статические права роли по имени (fallback, когда в БД нет переопределения).
 * Возвращает `null` для неизвестной (кастомной) роли.
 */
export function getStaticRolePermission(
  role: string | null | undefined,
): OrganizationPermissionCheck | null {
  if (role && role in staticRolePermissions) {
    return staticRolePermissions[role as OrganizationRole]
  }
  return null
}

/**
 * Проверяет, содержит ли карта прав все запрошенные действия.
 * Пустой запрос (`{}`) считается разрешённым.
 */
export function checkPermission(
  permissions: OrganizationPermissionCheck | null | undefined,
  required: OrganizationPermissionCheck,
): boolean {
  if (!permissions) return false
  for (const key of Object.keys(required) as OrganizationStatementKeys[]) {
    const requiredActions = required[key] ?? []
    const grantedActions = (permissions[key] ?? []) as string[]
    for (const action of requiredActions) {
      if (!grantedActions.includes(action)) return false
    }
  }
  return true
}

const organizationPermissions = { ac, roles: { owner, manager, teacher } }

export function canCreatePaycheck(
  session: {
    user: { id: string }
    memberRole?: string | null
    permissions?: OrganizationPermissionCheck
  } | null | undefined,
  userId: number,
): boolean {
  if (!session) return false
  const isSelf = Number(session.user.id) === userId
  if (!isSelf && session.memberRole === 'teacher') return false

  return (
    checkPermission(session.permissions, { paycheck: ['create'] }) ||
    (isSelf && checkPermission(session.permissions, { paycheck: ['createSelf'] }))
  )
}

export default organizationPermissions
