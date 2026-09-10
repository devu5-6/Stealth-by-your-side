import './index.css';
import 'katex/dist/katex.min.css';
import { marked } from 'marked';
import renderMathInElement from 'katex/contrib/auto-render';
import { getGeminiVisionAnswer } from './geminiVisionFallback';

marked.setOptions({
  gfm: true,
  breaks: true,
});

function renderAnswer(container, markdownText) {
  container.innerHTML = marked.parse(markdownText);
  renderMathInElement(container, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
      { left: '\\(', right: '\\)', display: false },
      { left: '\\[', right: '\\]', display: true },
    ],
    throwOnError: false,
  });
}

// DOM Elements
const snapBtn = document.getElementById('snapBtn');
const micBtn = document.getElementById('micBtn');
const audioSourceBtn = document.getElementById('audioSourceBtn');
const liveTranscript = document.getElementById('liveTranscript');
const responseFeed = document.getElementById('responseFeed');
const resumeToggleBtn = document.getElementById('resumeToggleBtn');
const resumeDrawer = document.getElementById('resumeDrawer');
const resumeInput = document.getElementById('resumeInput');
const saveResumeBtn = document.getElementById('saveResumeBtn');
const opacitySlider = document.getElementById('opacitySlider');
const minBtn = document.getElementById('minBtn');
const closeBtn = document.getElementById('closeBtn');

// State Variables
let isListening = false;
let socket = null;
let mediaRecorder = null;
let audioStream = null;
let audioMode = 'me'; // Default to 'me' (Microphone) for immediate reliable audio
let candidateResume = localStorage.getItem('candidate_resume') || '';

// Question accumulation & debounce timer
let accumulatedQuestion = '';
let silenceDebounceTimer = null;

if (candidateResume) {
  resumeInput.value = candidateResume;
}

// Audio Source Toggle ('me' vs 'recruiter')
audioSourceBtn?.addEventListener('click', () => {
  if (audioMode === 'me') {
    audioMode = 'recruiter';
    audioSourceBtn.textContent = '🔊 Recruiter';
    audioSourceBtn.className = 'text-[11px] px-2 py-0.5 rounded bg-amber-600/80 hover:bg-amber-600 text-white font-medium transition';
  } else {
    audioMode = 'me';
    audioSourceBtn.textContent = '🎤 Me';
    audioSourceBtn.className = 'text-[11px] px-2 py-0.5 rounded bg-emerald-600/80 hover:bg-emerald-600 text-white font-medium transition';
  }

  if (isListening) {
    stopListening();
    startListening();
  }
});

// Drawer Toggle
resumeToggleBtn?.addEventListener('click', () => {
  resumeDrawer.classList.toggle('hidden');
});

saveResumeBtn?.addEventListener('click', () => {
  candidateResume = resumeInput.value.trim();
  localStorage.setItem('candidate_resume', candidateResume);
  resumeDrawer.classList.add('hidden');
});

// Window controls
opacitySlider?.addEventListener('input', (e) => window.electronAPI.setOpacity(e.target.value));
minBtn?.addEventListener('click', () => window.electronAPI.minimize());
closeBtn?.addEventListener('click', () => window.electronAPI.close());

// --- Screen Capture Trigger ---
snapBtn?.addEventListener('click', handleScreenAnalysis);
window.electronAPI.onTriggerScreenCapture(handleScreenAnalysis);

async function handleScreenAnalysis() {
  const env = await window.electronAPI.getEnv();
  const groqKey = env.GROQ_API_KEY;
  const geminiKey = env.GEMINI_API_KEY;
  const geminiVisionModel = env.GEMINI_VISION_MODEL || undefined;

  if (!geminiKey && !groqKey) {
    alert('Missing GEMINI_API_KEY or GROQ_API_KEY in .env file');
    return;
  }

  const card = document.createElement('div');
  card.className = 'p-3 bg-white/5 rounded-lg border border-indigo-700/50 space-y-2 animate-fade-in';
  card.innerHTML = `
    <div class="model-source text-[11px] font-semibold text-indigo-400">📷 Snap Answer: Gemini</div>
    <div class="answer-content markdown-body text-gray-200 text-xs">⚡ Scanning screen...</div>
  `;
  responseFeed.prepend(card);

  const sourceLabel = card.querySelector('.model-source');
  const answerContainer = card.querySelector('.answer-content');
  let base64Image = '';
  const geminiSystemPrompt = `You are a live assessment solver.
CRITICAL FORMAT RULES:
1. First identify what the question is asking: code, multiple-choice, debugging, explanation, output prediction, or another task.
2. If it is a coding question, give **Code** first with a complete runnable solution.
3. If it is a debugging question, give the fixed code or exact bug fix first.
4. If it is multiple-choice, give the correct option/answer first.
5. If it asks for explanation, output, complexity, or any other answer, give the direct answer first.
6. After the answer/code/fix, give **Explanation** with exactly 5 to 6 short bullet points.
7. Use simple, easy English. Keep it direct, practical, and beginner-friendly.
8. Keep the answer complete and concise. Do not exceed 600 tokens.
9. Do not reveal internal analysis, such as "I am analyzing", "this looks good", or what you are checking.
10. No greetings, no long theory, no dry-run table, no extra sections.`;

  const qwenSystemPrompt = `You are a screenshot coding-answer solver.
Return only the final answer the user should submit.

QWEN OUTPUT RULES:
1. If code is needed, start immediately with one complete runnable code block in the correct language.
2. If it is multiple-choice, start immediately with the option and answer.
3. If it asks for output, explanation, complexity, or a direct text answer, start immediately with that answer.
4. Do not write problem analysis, algorithm notes, implementation details, or phrases like "The user wants me to".
5. After the answer/code/fix, write **Explanation** with exactly 4 short bullet points.
6. Keep it concise, but never leave code incomplete.
7. No greetings, no restating the screenshot, no dry-run table, no extra sections.`;

  const runQwenFallback = async () => {
    if (!groqKey) {
      throw new Error('Missing GROQ_API_KEY in .env file');
    }

    sourceLabel.textContent = '📷 Snap Answer: Qwen fallback';
    answerContainer.textContent = 'Gemini failed. Trying Qwen fallback...';

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.6-27b',
        stream: true,
        temperature: 0.1,
        max_completion_tokens: 800,
        messages: [
          { role: 'system', content: qwenSystemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read the screenshot and answer directly. If code is needed, return complete code first, then exactly 4 short explanation bullets.' },
              {
                type: 'image_url',
                image_url: {
                  url: base64Image,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Qwen API Error (${response.status}): ${errText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = '';
    answerContainer.innerHTML = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter((l) => l.trim().startsWith('data: '));

      for (const line of lines) {
        const payload = line.replace(/^data: /, '').trim();
        if (payload === '[DONE]') {
          if (!accumulatedText.trim()) {
            throw new Error('Qwen returned an empty answer.');
          }
          return;
        }

        try {
          const parsed = JSON.parse(payload);
          const token = parsed.choices[0]?.delta?.content || '';
          accumulatedText += token;
          renderAnswer(answerContainer, accumulatedText);
        } catch (_) {}
      }
    }

    if (!accumulatedText.trim()) {
      throw new Error('Qwen returned an empty answer.');
    }
  };

  try {
    base64Image = await window.electronAPI.captureScreen();
    if (!base64Image) {
      answerContainer.textContent = 'Failed to capture screen.';
      return;
    }

    answerContainer.textContent = '⚡ Extracting and solving question...';

    const geminiAnswer = await getGeminiVisionAnswer({
      apiKey: geminiKey,
      base64Image,
      systemPrompt: geminiSystemPrompt,
      model: geminiVisionModel,
      timeoutMs: 60000,
    });
    renderAnswer(answerContainer, geminiAnswer);
  } catch (error) {
    console.error('Gemini vision error:', error);

    try {
      await runQwenFallback();
    } catch (fallbackError) {
      console.error('Qwen vision fallback error:', fallbackError);
      answerContainer.textContent = `Gemini failed: ${error.message}\nQwen fallback also failed: ${fallbackError.message}`;
    }
  }
}

// --- Deepgram Live Audio Pipeline ---
micBtn?.addEventListener('click', async () => {
  if (!isListening) {
    await startListening();
  } else {
    stopListening();
  }
});

async function startListening() {
  const env = await window.electronAPI.getEnv();
  const deepgramKey = env.DEEPGRAM_API_KEY;

  if (!deepgramKey) {
    alert('Please provide DEEPGRAM_API_KEY in your .env file');
    return;
  }

  try {
    if (audioMode === 'me') {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });
    } else {
      // Recruiter mode via DisplayMedia Loopback
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      displayStream.getVideoTracks().forEach((t) => t.stop());
      const audioTracks = displayStream.getAudioTracks();

      if (audioTracks.length === 0) {
        alert('Make sure to check "Share audio" in the popup window!');
        stopListening();
        return;
      }
      audioStream = new MediaStream(audioTracks);
    }

    socket = new WebSocket(
      'wss://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&interim_results=true&endpointing=1500',
      ['token', deepgramKey]
    );

    socket.onopen = () => {
      mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
          socket.send(event.data);
        }
      };
      mediaRecorder.start(250);

      isListening = true;
      micBtn.textContent = '⏹️ Stop';
      micBtn.className = 'text-[11px] px-2 py-0.5 rounded bg-rose-600 hover:bg-rose-500 text-white font-medium transition';
      if (liveTranscript) liveTranscript.textContent = 'Listening...';
    };

    socket.onmessage = (message) => {
      const data = JSON.parse(message.data);
      const text = data.channel?.alternatives[0]?.transcript || '';

      if (text.trim().length > 0) {
        if (liveTranscript) liveTranscript.textContent = text;
        resetSilenceTimer();
      }

      if (data.is_final && text.trim().length > 0) {
        accumulatedQuestion += ' ' + text.trim();
      }

      if (data.speech_final) {
        resetSilenceTimer();
      }
    };

    socket.onerror = (err) => {
      console.error('Deepgram Error:', err);
      stopListening();
    };

    socket.onclose = () => {
      stopListening();
    };
  } catch (err) {
    console.error('Audio capture error:', err);
    alert('Audio capture failed. Check microphone permissions or audio device.');
    stopListening();
  }
}

function resetSilenceTimer() {
  clearTimeout(silenceDebounceTimer);
  silenceDebounceTimer = setTimeout(() => {
    processQuestionIfReady();
  }, 2500);
}

function processQuestionIfReady() {
  clearTimeout(silenceDebounceTimer);
  const finalQuestion = accumulatedQuestion.trim();

  if (finalQuestion.length >= 5) {
    accumulatedQuestion = '';
    if (liveTranscript) liveTranscript.textContent = 'Generating answer...';
    triggerGroqAnswer(finalQuestion);
  }
}

function stopListening() {
  clearTimeout(silenceDebounceTimer);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (audioStream) {
    audioStream.getTracks().forEach((track) => track.stop());
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }

  isListening = false;
  micBtn.textContent = '🎙️ Start';
  micBtn.className = 'text-[11px] px-2 py-0.5 rounded bg-blue-600/80 hover:bg-blue-600 text-white font-medium transition';
  if (liveTranscript) liveTranscript.textContent = 'Paused.';
}

// --- Groq LLM Streaming ---
async function triggerGroqAnswer(questionText) {
  const env = await window.electronAPI.getEnv();
  const groqKey = env.GROQ_API_KEY;

  if (!groqKey) {
    console.error('Missing GROQ_API_KEY');
    return;
  }

  const card = document.createElement('div');
  card.className = 'p-3 bg-white/5 rounded-lg border border-gray-700/50 space-y-2';
  card.innerHTML = `
    <div class="text-[11px] font-semibold text-blue-400">Q: ${questionText}</div>
    <div class="answer-content markdown-body text-gray-200 space-y-1 text-xs">⚡ Generating...</div>
  `;
  responseFeed.prepend(card);

  const answerContainer = card.querySelector('.answer-content');

//   const systemPrompt = `You are an interview copilot.
// Candidate Background Context:
// """
// ${candidateResume || 'Standard software engineering best practices.'}
// """

// Instructions:
// 1. Provide a direct, concise technical answer (3-4 bullet points) using standard markdown syntax (start each point with "* ").
// 2. Ground technical experiences in the candidate's context where applicable.
// 3. NEVER write conversational introductions or fluff. Jump straight to the bullets.
// 4. Respond as a knowledgeable human candidate would answer in a technical interview.
// 5. If code is needed, provide a clean, short fenced code block (\`\`\`language ... \`\`\`). Keep code minimal and directly relevant.`;
const systemPrompt = `You are Dev Shankar, a Full Stack Developer (ex-Artifex One, Leapcraft ApS) interviewing for a Full Stack Web Developer role.

Profile & Grounding:
- Technical Stack: Next.js, React, TypeScript, Python, Django, DRF, PostgreSQL, Redis, Core Web Vitals.
- Mindset: High ownership, collaborative, pragmatic, receptive to feedback.

CRITICAL RULE — USE SIMPLE, PLAIN LANGUAGE:
- Speak in everyday, clear, simple conversational English. Avoid overly complex vocabulary, buzzwords, or textbook jargon.
- Write short, clear sentences that are easy to read and say out loud without stumbling.
- Explain technical concepts simply, as if explaining to a smart teammate over coffee.

QUESTION ROUTING:

1. IF BEHAVIORAL / SOFT SKILLS (e.g., "How do you handle criticism?", conflict, teamwork):
   - DO NOT mention code frameworks or backend architecture.
   - Answer directly using "I" with humility and common sense.
   - Structure:
     * 1 clear opening sentence stating your perspective.
     * 5-6 simple bullet points (* ) on what you actually do (e.g., listening carefully, not taking it personally, asking questions to understand their point, and focusing on making the product better).

2. IF TECHNICAL (e.g., Next.js, Django, databases, Core Web Vitals):
   - 1 simple opening sentence answering the core question.
   - 5-6 practical, clean bullet points (* ) showing how you use it in Next.js or Django without unnecessary fluff.
   - If code is needed: short, minimal fenced code block.

3. PHONETIC CORRECTION:
   - Fix mistranscriptions naturally (e.g., "next GS" -> Next.js, "jungle" -> Django).

4. GENERAL RULES:
   - Sound like a genuine, calm, thoughtful engineer talking naturally.
   - Never use filler like "Sure!", "Great question!", or "Certainly!".
   - Leave an empty blank line between bullet points.`;
   
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        stream: true,
        temperature: 0.5,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: questionText },
        ],
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      answerContainer.textContent = `API Error (${response.status}): ${errBody}`;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = '';
    answerContainer.innerHTML = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter((l) => l.trim().startsWith('data: '));

      for (const line of lines) {
        const payload = line.replace(/^data: /, '').trim();
        if (payload === '[DONE]') {
          if (liveTranscript) liveTranscript.textContent = 'Listening...';
          return;
        }

        try {
          const parsed = JSON.parse(payload);
          const token = parsed.choices[0]?.delta?.content || '';
          accumulatedText += token;
          renderAnswer(answerContainer, accumulatedText);
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error('Groq Streaming Error:', err);
    answerContainer.textContent = 'Network or API error while streaming response.';
  }
}
