const memory = new Map<string, number>();

export async function getCounter(key: string): Promise<number | null> {
  return memory.get(key) ?? null;
}

export async function putCounter(key: string, value: number): Promise<void> {
  memory.set(key, value);
}
