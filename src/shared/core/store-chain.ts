// Общее звено записей в хранилище моста: один порядок на всех писателей.

/**
 * Идущая запись: вторая встаёт за первой — транзакций у хранилища нет.
 */
let chain: Promise<void> = Promise.resolve()

/** Ставит любую операцию чтения или записи в общий порядок хранилища. */
export function serial<T>(task: () => Promise<T>): Promise<T> {
  const done = chain.then(task)
  chain = done.then(
    () => undefined,
    () => undefined,
  )
  return done
}

/**
 * Ставит запись в общий черёд; отказ задачи цепочку не рвёт, наружу отдаётся обещание задачи.
 */
export function serialWrite(task: () => Promise<void>): Promise<void> {
  return serial(task)
}
