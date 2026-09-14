-- CreateEnum
CREATE TYPE "StatusEntity" AS ENUM ('STUDENT_GROUP', 'LESSON');

-- CreateEnum
CREATE TYPE "StatusChangeReason" AS ENUM ('ENROLLED', 'RETURNED', 'TRANSFERRED_OUT', 'TRANSFERRED_IN', 'DISMISSED', 'GROUP_CLOSED', 'REMOVED', 'LESSON_CANCELLED', 'LESSON_RESTORED', 'IMPORTED');

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

-- Прошлое — одна строка «как есть» на каждую запись в группу: статус, дата и
-- комментарий из колонок, автора нет. Глубже истории в базе нет — колонка
-- перезаписывалась.
--
-- Здесь, а не скриптом после деплоя: между миграцией и ручным запуском скрипта
-- новый код уже пишет журнал, и отчисление в этом окне оставило бы запись без
-- исходной строки — цепочку, которая начинается не с создания.
--
-- Имя группы — снимок по правилу `getGroupName` (`@repo/core/group`): своё
-- название, иначе «Курс Пн 16:00, Ср 16:00». Уроки не заполняются: у отменённого
-- урока честной даты отмены нет, `updatedAt` двигало и обычное редактирование.
INSERT INTO "StatusChange" (
    "entity", "fromStatus", "toStatus", "reason", "comment", "effectiveAt",
    "organizationId", "studentId", "groupId", "groupName"
)
SELECT
    'STUDENT_GROUP', NULL, sg."status"::TEXT, 'IMPORTED', sg."statusComment", sg."statusChangedAt",
    sg."organizationId", sg."studentId", sg."groupId",
    COALESCE(NULLIF(g."name", ''), TRIM(c."name" || ' ' || COALESCE(s."label", '')))
FROM "StudentGroup" sg
JOIN "Group" g ON g."id" = sg."groupId"
JOIN "Course" c ON c."id" = g."courseId"
LEFT JOIN LATERAL (
    SELECT string_agg(
        (ARRAY['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'])[gs."dayOfWeek" + 1] || ' ' || gs."time",
        ', ' ORDER BY (gs."dayOfWeek" + 6) % 7
    ) AS "label"
    FROM "GroupSchedule" gs
    WHERE gs."groupId" = g."id"
) s ON TRUE
ORDER BY sg."organizationId", sg."studentId", sg."groupId";
