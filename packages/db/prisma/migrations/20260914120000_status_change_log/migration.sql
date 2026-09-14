-- CreateEnum
CREATE TYPE "StatusEntity" AS ENUM ('STUDENT_GROUP', 'LESSON');

-- CreateEnum
CREATE TYPE "StatusChangeReason" AS ENUM ('ENROLLED', 'RETURNED', 'TRANSFERRED_OUT', 'TRANSFERRED_IN', 'DISMISSED', 'GROUP_CLOSED', 'LESSON_CANCELLED', 'LESSON_RESTORED');

-- CreateTable
CREATE TABLE "StatusChange" (
    "id" SERIAL NOT NULL,
    "entity" "StatusEntity" NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "reason" "StatusChangeReason" NOT NULL,
    "comment" TEXT,
    "effectiveAt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approximate" BOOLEAN NOT NULL DEFAULT false,
    "organizationId" INTEGER NOT NULL,
    "actorUserId" INTEGER,
    "studentId" INTEGER,
    "groupId" INTEGER,
    "lessonId" INTEGER,
    "groupName" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "StatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StatusChange_organizationId_studentId_effectiveAt_idx" ON "StatusChange"("organizationId", "studentId", "effectiveAt");

-- CreateIndex
CREATE INDEX "StatusChange_organizationId_groupId_effectiveAt_idx" ON "StatusChange"("organizationId", "groupId", "effectiveAt");

-- CreateIndex
CREATE INDEX "StatusChange_lessonId_idx" ON "StatusChange"("lessonId");

-- CreateIndex
CREATE INDEX "StatusChange_organizationId_effectiveAt_idx" ON "StatusChange"("organizationId", "effectiveAt");

-- AddForeignKey
ALTER TABLE "StatusChange" ADD CONSTRAINT "StatusChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusChange" ADD CONSTRAINT "StatusChange_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusChange" ADD CONSTRAINT "StatusChange_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusChange" ADD CONSTRAINT "StatusChange_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusChange" ADD CONSTRAINT "StatusChange_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- История записей в группы до запуска журнала — восстановленная по тому, что есть в
-- базе. Здесь, а не скриптом после деплоя: между миграцией и ручным запуском скрипта
-- новый код уже пишет журнал, и отчисление в этом окне оставило бы цепочку, которая
-- начинается не с зачисления.
--
-- На каждую запись — цепочка из одной или двух строк, без автора:
--   1. зачисление: `null → ACTIVE` (у живых сейчас — `null → их статус`);
--   2. если запись закрыта — итоговый переход `ACTIVE → статус` с датой и
--      комментарием из колонок: отчисление, перевод, закрытие с группой.
-- Порядок `id` повторяет порядок событий: сверка берёт последнюю строку по `id`, а
-- лента в карточке при равной дате ставит выше строку с большим `id`. Внутри дня
-- ученика записи идут в порядке создания (`createdAt`): перевод в живом коде сначала
-- закрывает старую запись, потом заводит новую, и цепочка «А → Б → В» за один день
-- так и ложится — зачисление каждой записи раньше её закрытия, а закрытие раньше
-- зачисления следующей.
--
-- Дата зачисления — день создания записи в поясе школы. Если уроки в посещаемости
-- начались раньше (записи загрузки 17–27.02.2026 и те, что завели заново позже), —
-- первый урок, с пометкой `approximate`: это «не позже чем», а не «когда».
-- Уходы, затёртые возвратом, не восстанавливаются: следа от них в базе нет.
--
-- Имя группы — снимок по правилу `getGroupName` (`@repo/core/group`): своё
-- название, иначе «Курс Пн 16:00, Ср 16:00». Уроки не заполняются: у отменённого
-- урока честной даты отмены нет, `updatedAt` двигало и обычное редактирование.
CREATE TEMP TABLE "_enrollment" AS
SELECT
    sg."organizationId", sg."studentId", sg."groupId", sg."createdAt",
    sg."status"::TEXT AS "status", sg."statusChangedAt", sg."statusComment",
    sg."status" IN ('ACTIVE', 'TRIAL') AS "live",
    COALESCE(NULLIF(g."name", ''), TRIM(c."name" || ' ' || COALESCE(s."label", ''))) AS "groupName",
    TO_CHAR(
        sg."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE
            CASE WHEN o."timezone" IN (SELECT "name" FROM pg_timezone_names) THEN o."timezone" ELSE 'Europe/Moscow' END,
        'YYYY-MM-DD'
    ) AS "createdDay",
    fl."firstLesson"
FROM "StudentGroup" sg
JOIN "Organization" o ON o."id" = sg."organizationId"
JOIN "Group" g ON g."id" = sg."groupId"
JOIN "Course" c ON c."id" = g."courseId"
LEFT JOIN LATERAL (
    SELECT STRING_AGG(
        (ARRAY['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'])[gs."dayOfWeek" + 1] || ' ' || gs."time",
        ', ' ORDER BY (gs."dayOfWeek" + 6) % 7
    ) AS "label"
    FROM "GroupSchedule" gs
    WHERE gs."groupId" = g."id"
) s ON TRUE
LEFT JOIN LATERAL (
    -- Отработки и пробные — не признак членства в группе.
    SELECT MIN(l."date") AS "firstLesson"
    FROM "Attendance" a
    JOIN "Lesson" l ON l."id" = a."lessonId"
    WHERE a."studentId" = sg."studentId" AND l."groupId" = sg."groupId"
      AND a."makeupForAttendanceId" IS NULL AND NOT a."isTrial"
) fl ON TRUE;

-- День зачисления: самое раннее из «создана», «первый урок» и, у закрытых, «день
-- закрытия» — иначе отчисление задним числом встало бы в ленте раньше зачисления.
-- `LEAST` пропускает NULL.
ALTER TABLE "_enrollment"
    ADD COLUMN "enrolledDay" TEXT, ADD COLUMN "approximate" BOOLEAN, ADD COLUMN "hop" BIGINT;
UPDATE "_enrollment" SET
    "enrolledDay" = LEAST("createdDay", "firstLesson", CASE WHEN NOT "live" THEN "statusChangedAt" END);
UPDATE "_enrollment" SET "approximate" = "enrolledDay" < "createdDay";
-- Номер записи среди записей ученика по времени создания.
UPDATE "_enrollment" e SET "hop" = r."hop"
FROM (
    SELECT "studentId", "groupId",
        DENSE_RANK() OVER (PARTITION BY "studentId" ORDER BY "createdAt", "groupId") AS "hop"
    FROM "_enrollment"
) r
WHERE r."studentId" = e."studentId" AND r."groupId" = e."groupId";

-- `id` проставляются явно, одной нумерацией: порядок вставки из `INSERT … SELECT`
-- стандарт не обещает. Таблица только что создана и пуста.
INSERT INTO "StatusChange" (
    "id", "entity", "fromStatus", "toStatus", "reason", "comment", "effectiveAt", "approximate",
    "organizationId", "studentId", "groupId", "groupName"
)
SELECT
    ROW_NUMBER() OVER (ORDER BY r."organizationId", r."studentId", r."effectiveAt", r."sortKey"),
    'STUDENT_GROUP', r."fromStatus", r."toStatus", r."reason", r."comment", r."effectiveAt", r."approximate",
    r."organizationId", r."studentId", r."groupId", r."groupName"
FROM (
    -- Зачисление: `null → ACTIVE`, у живых записей — `null → их статус`.
    SELECT
        NULL AS "fromStatus",
        CASE WHEN e."live" THEN e."status" ELSE 'ACTIVE' END AS "toStatus",
        -- Запись создана в день, когда другая запись того же ученика закрыта переводом, —
        -- это приход переводом, а не зачисление.
        CASE WHEN NOT e."approximate" AND EXISTS (
            SELECT 1 FROM "StudentGroup" t
            WHERE t."studentId" = e."studentId" AND t."groupId" <> e."groupId"
              AND t."status" = 'TRANSFERRED' AND t."statusChangedAt" = e."createdDay"
        ) THEN 'TRANSFERRED_IN' ELSE 'ENROLLED' END::"StatusChangeReason" AS "reason",
        CASE WHEN e."live" THEN e."statusComment" END AS "comment",
        -- У живой записи строка единственная и обязана совпасть с колонкой — кроме
        -- приблизительной, у которой колонка хранит день загрузки, а не зачисления.
        CASE WHEN e."live" AND NOT e."approximate" THEN e."statusChangedAt" ELSE e."enrolledDay" END AS "effectiveAt",
        e."approximate",
        2 * e."hop" AS "sortKey",
        e."organizationId", e."studentId", e."groupId", e."groupName"
    FROM "_enrollment" e

    UNION ALL

    -- Итоговый переход закрытой записи: `ACTIVE → статус`.
    SELECT
        'ACTIVE',
        e."status",
        CASE e."status"
            WHEN 'DISMISSED' THEN 'DISMISSED'
            WHEN 'TRANSFERRED' THEN 'TRANSFERRED_OUT'
            ELSE 'GROUP_CLOSED'
        END::"StatusChangeReason",
        e."statusComment",
        e."statusChangedAt",
        FALSE,
        2 * e."hop" + 1,
        e."organizationId", e."studentId", e."groupId", e."groupName"
    FROM "_enrollment" e
    WHERE NOT e."live"
) r;

-- Последовательность — за последний явный `id`. На пустой базе `MAX` даёт NULL, и
-- `setval` ничего не трогает.
SELECT setval(pg_get_serial_sequence('"StatusChange"', 'id'), (SELECT MAX("id") FROM "StatusChange"));

DROP TABLE "_enrollment";
