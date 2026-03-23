export type QuizQuestion = {
  question: string;
  options: [string, string, string, string];
  correctAnswer: string;
};

export type QuizPayload = {
  quiz: QuizQuestion[];
};

