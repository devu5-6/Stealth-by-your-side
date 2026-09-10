const DEFAULT_GEMINI_VISION_MODEL = 'gemini-3.1-flash-lite';

function extractInlineImage(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);

  if (!match) {
    throw new Error('Invalid screenshot image data.');
  }

  return {
    mimeType: match[1],
    data: match[2],
  };
}

function extractGeminiText(result) {
  return result?.candidates
    ?.flatMap((candidate) => candidate.content?.parts || [])
    ?.map((part) => part.text || '')
    ?.join('')
    ?.trim();
}

export async function getGeminiVisionAnswer({
  apiKey,
  base64Image,
  systemPrompt,
  model = DEFAULT_GEMINI_VISION_MODEL,
  timeoutMs = 60000,
}) {
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY in .env file');
  }

  const inlineImage = extractInlineImage(base64Image);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: 'Read the question in this screenshot. Answer exactly what it asks. If code or a fix is needed, give it first. Then add only 4 short and simple explanation bullet points.',
              },
              {
                inlineData: inlineImage,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 600,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    const answer = extractGeminiText(result);

    if (!answer) {
      throw new Error('Gemini returned an empty answer.');
    }

    return answer;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Gemini request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export const getGeminiVisionFallbackAnswer = getGeminiVisionAnswer;
