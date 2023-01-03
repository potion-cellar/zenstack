import { z } from 'zod';

import type { Prisma } from '@prisma/client';

const Schema: z.ZodType<Prisma.TodoUncheckedCreateWithoutListInput> = z
    .object({
        id: z.string().optional(),
        createdAt: z.date().optional(),
        updatedAt: z.date().optional(),
        ownerId: z.string(),
        title: z.string(),
        completedAt: z.date().optional().nullable(),
    })
    .strict();

export const TodoUncheckedCreateWithoutListInputObjectSchema = Schema;