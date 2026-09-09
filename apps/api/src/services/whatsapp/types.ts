import { WhatsAppMessage } from '../../interfaces/whatsapp/webhook';

type OviUser = {
  id: string;
  name: string | null;
};

type AgentSharedState = {
  phoneNumber: {
    id: string;
    phoneNumber: string;
    isTestNumber: boolean;
    name: string | null;
    isIdentified: boolean;
  };

  conversation: {
    id: string;
    isTestConversation: boolean;
  };

  // Agent working memory (ephemeral)
  agentData: {
    userIdentification?: {
      invitationCode?: string;
      invitingUser?: OviUser;
      providedName?: string;
    };
    routing: {
      currentAgent: string | null;
      routingReason: string;
    };
  };
};

type IsLongerThan<
  S extends string,
  N extends number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  A extends any[] = [],
> = S extends `${infer _}${infer Rest}`
  ? A['length'] extends N
    ? true
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      IsLongerThan<Rest, N, [any, ...A]>
  : false;

type MaxLength<S extends string, N extends number> = IsLongerThan<S, N> extends true ? never : S;

const PRESERVE = Symbol('PRESERVE');

type OutgoingMessage = {
  header?: string;
  footer?: string;
  body: string;
  buttons?: {
    id: string;
    title: MaxLength<string, 20>;
    __brand: 'button';
  }[];
  ctaUrlButton?: {
    title: MaxLength<string, 20>;
    url: string;
    __brand: 'ctaUrlButton';
  };
  delay?: number;
  expectedHandler?: string | typeof PRESERVE;
};

function button<T extends string>(o: {
  id: string;
  title: MaxLength<T, 20>;
}): {
  id: string;
  title: MaxLength<T, 20>;
  __brand: 'button';
} {
  return o as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

type LoopMessage<T> = (args: T) => OutgoingMessage | OutgoingMessage[];

type LoopResponse<T> = {
  message: LoopMessage<T>;
  description: string;
} & (T extends undefined ? { exampleArgs?: undefined } : { exampleArgs: T });

/**
 * Type helper for creating a loop stage response
 */
function response<T>({
  message,
  description,
  exampleArgs,
}: {
  message: LoopMessage<T>;
  description: string;
} & (T extends void ? { exampleArgs?: undefined } : { exampleArgs: T })) {
  return {
    message,
    description,
    exampleArgs,
  };
}

type LoopProcess = (
  message: WhatsAppMessage,
  state: AgentSharedState,
  routingId: string,
) => Promise<OutgoingMessage | OutgoingMessage[] | null>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoopStage<T extends Record<string, LoopResponse<any>>> = {
  responses: T;
  handler: LoopProcess;
  description: string;
  availableUnauthed?: boolean;
};

/**
 * Type helper for creating a loop stage
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stage<T extends Record<string, LoopResponse<any>>>({
  responses,
  handler,
  description,
  availableUnauthed,
}: {
  responses: T;
  handler: LoopProcess;
  description: string;
  availableUnauthed?: boolean;
}) {
  return {
    responses,
    handler,
    description,
    availableUnauthed,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loop<T extends Record<string, LoopStage<any>>> = {
  stages: T;
  description: string;
  entryPoint: keyof T | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTemplates?: () => Promise<LoopStage<any>>;
  isIndexed: boolean;
  button?: {
    id: string;
    title: string;
    __brand: 'button';
  };
};

/**
 * Type helper for creating a loop
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loop<T extends Record<string, LoopStage<any>>>({
  stages,
  description,
  entryPoint,
  getTemplates,
  isIndexed,
  button,
}: {
  stages: T;
  description: string;
  entryPoint: keyof T | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTemplates?: () => Promise<LoopStage<any>>;
  /** does this loop appear as somewhere the supervisor can direct the user to? */
  isIndexed: boolean;
  button?: {
    id: string;
    title: string;
    __brand: 'button';
  };
}): Loop<T> {
  return {
    stages,
    description,
    entryPoint,
    getTemplates,
    isIndexed,
    button,
  };
}

export {
  OviUser,
  AgentSharedState,
  LoopStage,
  LoopResponse,
  LoopMessage,
  LoopProcess,
  OutgoingMessage,
  loop,
  stage,
  response,
  button,
  PRESERVE,
};
