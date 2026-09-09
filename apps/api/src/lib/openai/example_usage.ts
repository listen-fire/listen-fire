import { openAIResponses } from './index';

// Mock function to simulate weather tool
async function getWeather({ location }: { location: string }) {
  console.log(`Getting weather for ${location}...`);
  // Simulate async work
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (location.toLowerCase().includes('london')) {
    return { temperature: 15, condition: 'Cloudy' };
  } else if (
    location.toLowerCase().includes('sf') ||
    location.toLowerCase().includes('francisco')
  ) {
    return { temperature: 20, condition: 'Sunny' };
  } else {
    return { temperature: 25, condition: 'Unknown' };
  }
}

// Mock function for getting time
async function getTime({ location }: { location: string }) {
  console.log(`Getting time for ${location}...`);
  // Simulate async work
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { time: new Date().toISOString(), location };
}

async function runExample() {
  const toolsMap = {
    getWeather: getWeather,
    getTime: getTime,
  };

  const toolDefinitions = [
    {
      type: 'function',
      name: 'getWeather',
      description: 'Get current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City and state/country' },
        },
        required: ['location'],
      },
    },
    {
      type: 'function',
      name: 'getTime',
      description: 'Get current time for a location',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City and state/country' },
        },
        required: ['location'],
      },
    },
  ];

  console.log('Starting OpenAI Responses interaction...');
  try {
    const result = await openAIResponses(
      {
        model: 'gpt-4o',
        input: [
          {
            role: 'user',
            content:
              'What is the weather and time in London and San Francisco right now? Please give me a summary.',
          },
        ],
        tools: toolDefinitions as any,
      },
      toolsMap,
    );

    console.log('\nFinal Result:');
    console.log(result);
  } catch (error) {
    console.error('Error executing example:', error);
  }
}

// Only run if called directly
if (require.main === module) {
  runExample();
}
