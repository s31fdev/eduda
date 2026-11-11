export const MANUAL_LESSON_PACKAGE_NAME = 'Ручное начисление'

export function isLegacyManualLessonPackageName(name: string) {
  return name === 'Подарок' || name.startsWith('Подарок:')
}

export function displayPackageName(name: string) {
  return isLegacyManualLessonPackageName(name)
    ? MANUAL_LESSON_PACKAGE_NAME + name.slice('Подарок'.length)
    : name
}
