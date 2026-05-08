import {
  intro,
  outro,
  text,
  password,
  select,
  confirm,
  spinner,
  isCancel,
  cancel,
} from "@clack/prompts";

export {
  intro,
  outro,
  text,
  password,
  select,
  confirm,
  spinner,
  isCancel,
  cancel,
};

export function bail(value: unknown): asserts value is Exclude<unknown, symbol> {
  if (isCancel(value)) {
    cancel("Aborted by user.");
    process.exit(0);
  }
}
