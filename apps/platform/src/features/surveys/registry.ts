/**
 * Анкеты, которые принимает `/api/surveys/<ключ>`.
 *
 * Сами страницы лежат не в приложении, а статикой на сервере
 * (`/var/www/pages/<имя>.html`, см. «Прод» в CLAUDE.md), поэтому ключ — это
 * единственное, что связывает страницу с таблицей. Закрыть анкету — убрать её
 * отсюда: страница останется, а ответы перестанут приниматься.
 */
export const SURVEYS = {
  /** Опрос учеников об играх: `eduda.online/pages/games-survey`. */
  games: { versions: ['2026.1'] },
} as const satisfies Record<string, { versions: readonly string[] }>

export type SurveyKey = keyof typeof SURVEYS

export function isOpenSurvey(key: string): key is SurveyKey {
  return Object.hasOwn(SURVEYS, key)
}
