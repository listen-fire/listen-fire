type ProcessMessage = { level: 'info' | 'debug' | 'trace'; timestamp: string } & (
  | { type: 'text'; content: string }
  | { type: 'header'; content: string }
  | { type: 'table'; content: TableContent }
);

interface TableContent {
  headers: string[];
  rows: (string | number)[][];
}

class MessageCollector {
  private messages: ProcessMessage[] = [];

  subCollector(): MessageCollector & { commit: () => void } {
    const subCollector = new MessageCollector() as MessageCollector & { commit: () => void };
    subCollector.commit = () => {
      this.messages.push(...subCollector.getMessages());
    };
    return subCollector;
  }

  text(content: string, level: 'info' | 'debug' | 'trace' = 'info') {
    this.messages.push({
      level,
      timestamp: new Date().toISOString(),
      type: 'text',
      content,
    });
  }

  header(content: string, level: 'info' | 'debug' | 'trace' = 'info') {
    this.messages.push({
      level,
      timestamp: new Date().toISOString(),
      type: 'header',
      content,
    });
  }

  table(
    headers: string[],
    rows: (string | number)[][],
    level: 'info' | 'debug' | 'trace' = 'info',
  ) {
    this.messages.push({
      level,
      timestamp: new Date().toISOString(),
      type: 'table',
      content: { headers, rows },
    });
  }

  getMessages(): ProcessMessage[] {
    return this.messages;
  }
}

export { MessageCollector, ProcessMessage };
