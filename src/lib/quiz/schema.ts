import { z } from "zod";

export const QuizQuestionSchema = z.object({
  question: z.string().min(3),
  options: z
    .array(z.string().min(1))
    .length(4)
    .transform((arr) => arr as [string, string, string, string]),
  correctAnswer: z.string().min(1),
});

export const QuizPayloadSchema = z.object({
  quiz: z.array(QuizQuestionSchema).min(5),
});

export function validateCorrectAnswer(
  q: z.infer<typeof QuizQuestionSchema>,
) {
  if (!q.options.includes(q.correctAnswer)) {
    return false;
  }
  return true;
}

