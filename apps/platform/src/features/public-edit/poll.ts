import * as z from 'zod'
import { TokenSchema } from './schemas'

// Разовый опрос родителей «Алгоритмики» (станция «Выборы»). Мероприятие
// временное, поэтому базу не трогаем: ответы пишутся в файл на сервере
// (`poll.server.ts`), а варианты живут здесь. Опрос кончился — удалить этот
// файл, `poll.server.ts`, блок на главной кабинета и скрипт итогов.

export const PARENT_POLL = {
  organizationId: 1,
  votes: 3,
  options: [
    {
      key: 'ai',
      eyebrow: 'Практикум по ИИ · раз в месяц · старт в ноябре',
      title: '«Все уже да, а я ещё нет»',
      price: '300–500 ₽',
      description:
        'Без снобизма и страшных слов: научим нейросеть писать письма, планировать неделю и объяснять домашку — на ваших задачах, с вашего телефона.',
    },
    {
      key: 'excel',
      eyebrow: 'Открытый урок · компьютерная грамотность · 1,5 часа',
      title: 'Excel, который не страшно открыть',
      price: '1000 ₽',
      description:
        'Таблицы, офисные программы и онлайн-сервисы, которые экономят часы. Отчёт за 10 минут вместо вечера — и в доме «шарит» в компьютере не только ребёнок.',
    },
    {
      key: 'toy',
      eyebrow: 'Мастер-класс родитель + ребёнок · декабрь',
      title: 'Ёлочная игрушка, которая светится',
      price: '1500 ₽ за пару',
      description:
        'Паяете вместе: настоящий паяльник, настоящая схема со светодиодами. Игрушка будет висеть на ёлке годами — и каждый раз напоминать, кто её сделал.',
    },
    {
      key: 'psychologist',
      eyebrow: 'Встреча с семейным психологом · ноябрь',
      title: 'Договориться без скандала',
      price: '300–500 ₽',
      description:
        'Как договориться про гаджеты, уроки и сон без крика. Как заметить, что в отношениях начало хромать доверие, и что с этим делать. Свои истории — только по желанию.',
    },
    {
      key: 'lesson',
      eyebrow: 'Попробуй сам · урок из курса вашего ребёнка',
      title: 'Урок вашего ребёнка — для вас',
      price: 'Бесплатно',
      description:
        'Та же программа, тот же педагог. Сделаете первый проект своими руками — и наконец поймёте, о чём ребёнок рассказывает за ужином.',
    },
  ],
} as const

const OPTION_KEYS: readonly string[] = PARENT_POLL.options.map((option) => option.key)
const OptionKeySchema = z.string().refine((key) => OPTION_KEYS.includes(key), 'Нет такого варианта')

export type PollAnswer = { votes: string[]; signups: string[] }

export const SavePollAnswerSchema = z.object({
  token: TokenSchema,
  // Повтор ключа — несколько голосов за один вариант.
  votes: z.array(OptionKeySchema).max(PARENT_POLL.votes),
  signups: z
    .array(OptionKeySchema)
    .refine((keys) => new Set(keys).size === keys.length, 'Повтор в записи'),
})

export type SavePollAnswerSchemaType = z.input<typeof SavePollAnswerSchema>
