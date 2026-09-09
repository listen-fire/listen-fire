import { metaWhatsappApi } from './metaApi';
import { LoopResponse, OutgoingMessage, stage } from './types';

async function getResponsesFromTemplates() {
  const templates = await metaWhatsappApi.getMessageTemplates();

  const responses = templates.map((template): LoopResponse<Record<string, string>> => {
    const header = template.components.find((component) => component.type === 'HEADER')?.text;
    const body = template.components.find((component) => component.type === 'BODY');
    const footer = template.components.find((component) => component.type === 'FOOTER')?.text;
    const buttons = template.components.filter((component) => component.type === 'BUTTONS');

    return {
      message: (parameters: Record<string, string>): OutgoingMessage => {
        let bodyText = body?.text;
        for (const [key, value] of Object.entries(parameters)) {
          const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
          bodyText = bodyText?.replace(regex, value);
        }
        return {
          header,
          footer,
          body: bodyText ?? '',
          buttons: buttons.length
            ? buttons
                .flatMap((button) => button.buttons)
                .map((button) => ({
                  id: 'test',
                  title: button.text,
                  __brand: 'button',
                }))
            : undefined,
        };
      },
      description: template.name,
      exampleArgs:
        body?.example?.body_text?.[0]?.reduce(
          (acc, param, idx) => {
            acc[`${idx + 1}`] = param;
            return acc;
          },
          {} as Record<string, string>,
        ) ?? {},
    };
  });

  return responses;
}

type TemplateMap<T> = Record<
  string,
  {
    description: string;
    routing: (args: T) => {
      expectedHandler?: string;
      buttonIds?: string[];
    };
    exampleArgs: Record<string, string>;
  }
>;

const getSchemaFromTemplates = async <T>(templateMap: TemplateMap<T>) => {
  const allResponses = await getResponsesFromTemplates();

  const responses: Record<string, LoopResponse<Record<string, string>>> = {};

  Object.entries(templateMap).forEach(([key, value]) => {
    const match = allResponses.find((response) => response.description === key);
    if (!match) {
      return;
    }

    responses[key] = {
      ...match,
      exampleArgs: {
        ...match.exampleArgs,
        ...value.exampleArgs,
      },
      message: (args: Record<string, string>) => {
        const base = match.message(args);

        const { expectedHandler, buttonIds } = value.routing(args as T);
        const bIds = [...(buttonIds ?? [])];

        if (Array.isArray(base)) {
          return base.map((message) => ({
            ...message,
            expectedHandler,
            buttons: message.buttons?.map((button) => ({
              ...button,
              id: bIds.shift()!,
            })),
          }));
        }

        return {
          ...base,
          expectedHandler,
          buttons: base.buttons?.map((button) => ({
            ...button,
            id: bIds.shift()!,
          })),
        };
      },
    };
  });

  return stage({
    responses,
    // No handler logic - we're never going to call this. This exclusively exists to document the templates we'd wish to call
    handler: async () => {
      return null;
    },
    description: 'Any templates we might wish to call',
  });
};

export { getSchemaFromTemplates,  };
