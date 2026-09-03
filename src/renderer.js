import './index.css';
import { marked } from 'marked';

// Configure marked options for code rendering and line breaks
marked.setOptions({
  gfm: true,
  breaks: true,
});

// DOM Elements
const snapBtn = document.getElementById('snapBtn');
const micBtn = document.getElementById('micBtn');
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
let candidateResume = localStorage.getItem('candidate_resume') || '';

// Question accumulation & debounce timer
let accumulatedQuestion = '';
let silenceDebounceTimer = null;

if (candidateResume) {
  resumeInput.value = candidateResume;
}

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

  if (!groqKey) {
    alert('Missing GROQ_API_KEY in .env file');
    return;
  }

  // Create UI Card for Vision Output
  const card = document.createElement('div');
  card.className = 'p-3 bg-white/5 rounded-lg border border-indigo-700/50 space-y-2 animate-fade-in';
  card.innerHTML = `
    <div class="text-[11px] font-semibold text-indigo-400">📷 Analyzing Screen Question...</div>
    <div class="answer-content markdown-body text-gray-200 text-xs">⚡ Scanning screen...</div>
  `;
  responseFeed.prepend(card);

  const answerContainer = card.querySelector('.answer-content');

  try {
    const base64Image = await window.electronAPI.captureScreen();
    if (!base64Image) {
      answerContainer.textContent = 'Failed to capture screen.';
      return;
    }

    answerContainer.textContent = '⚡ Extracting and solving question...';

    const systemPrompt = `You are an interview and technical assessment copilot.
1. Identify the primary coding question, multiple-choice quiz, or technical problem displayed on the user's screen.
2. Provide a direct, correct answer immediately:
   - For Multiple Choice: State the exact correct option and a 1-line justification.
   - For Coding Problems: Provide the optimal solution in clean code (fenced block) followed by 2-3 brief bullet points explaining Time/Space Complexity ($O(...)$).
3. Do not include introductory pleasantries.`;

    // Send Image to Vision Model (qwen/qwen3.6-27b on Groq)
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen/qwen3.6-27b', // Multimodal vision model from your active list
        stream: true,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this screen capture, locate the question or problem statement, and provide the complete solution.' },
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
      answerContainer.textContent = `Vision API Error: ${errText}`;
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
        if (payload === '[DONE]') return;

        try {
          const parsed = JSON.parse(payload);
          const token = parsed.choices[0]?.delta?.content || '';
          accumulatedText += token;
          answerContainer.innerHTML = marked.parse(accumulatedText);
        } catch (_) {}
      }
    }
  } catch (error) {
    console.error('Vision streaming error:', error);
    answerContainer.textContent = 'Error processing screen question.';
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
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
        sampleRate: 16000,
      },
    });

    // Deepgram live stream with punctuation and interim results
    socket = new WebSocket(
      'wss://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&interim_results=true&endpointing=500',
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
      liveTranscript.textContent = 'Listening... (speak your question)';
    };

    socket.onmessage = (message) => {
      const data = JSON.parse(message.data);
      const text = data.channel?.alternatives[0]?.transcript || '';

      // 1. Show live interim words as they are being spoken
      if (text.trim().length > 0) {
        liveTranscript.textContent = text;
      }

      // 2. Accumulate finalized phrases
      if (data.is_final && text.trim().length > 0) {
        accumulatedQuestion += ' ' + text.trim();
        resetSilenceTimer();
      }

      // 3. Trigger immediately if Deepgram signals end-of-speech
      if (data.speech_final) {
        processQuestionIfReady();
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
    console.error('Mic Access Error:', err);
    alert('Microphone access denied or unavailable.');
    stopListening();
  }
}

// Fallback timer: triggers LLM 1.2s after you stop speaking
function resetSilenceTimer() {
  clearTimeout(silenceDebounceTimer);
  silenceDebounceTimer = setTimeout(() => {
    processQuestionIfReady();
  }, 1200);
}

function processQuestionIfReady() {
  clearTimeout(silenceDebounceTimer);
  const finalQuestion = accumulatedQuestion.trim();
  
  // Only trigger if question is meaningful (more than 4 characters)
  if (finalQuestion.length >= 5) {
    accumulatedQuestion = '';
    liveTranscript.textContent = 'Generating answer...';
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
  liveTranscript.textContent = 'Paused.';
}

// --- Groq LLM Streaming ---
async function triggerGroqAnswer(questionText) {
  const env = await window.electronAPI.getEnv();
  const groqKey = env.GROQ_API_KEY;

  if (!groqKey) {
    console.error('Missing GROQ_API_KEY');
    return;
  }

  // Create new UI Card
  const card = document.createElement('div');
  card.className = 'p-3 bg-white/5 rounded-lg border border-gray-700/50 space-y-2';
  card.innerHTML = `
    <div class="text-[11px] font-semibold text-blue-400">Q: ${questionText}</div>
    <div class="answer-content text-gray-200 space-y-1 text-xs">⚡ Generating...</div>
  `;
  responseFeed.prepend(card);

  const answerContainer = card.querySelector('.answer-content');

  const systemPrompt = `You are an interview copilot.
Candidate Background Context:
"""
${candidateResume || 'Standard software engineering best practices.'}
"""

Instructions:
1. Provide a direct, concise technical answer (3-4 bullet points) using standard markdown syntax (start each point with "* ").
2. Ground technical experiences in the candidate's context where applicable.
3. NEVER write conversational introductions or fluff. Jump straight to the bullets.
4. Respond as a knowledgeable human candidate would answer in a technical interview.
5. Keep the language simple, natural, clear, and professional. Do not sound robotic or overly verbose.
6. If code is needed, provide a clean, short fenced code block (\`\`\`language ... \`\`\`). Keep code minimal and directly relevant.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b', // Fast active Groq model
        stream: true,
        temperature: 0.2,
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
          liveTranscript.textContent = 'Listening...';
          return;
        }

        try {
          const parsed = JSON.parse(payload);
          const token = parsed.choices[0]?.delta?.content || '';
          accumulatedText += token;
          
          // Render via marked to handle bullets, bold text, inline code, and code blocks cleanly
          answerContainer.innerHTML = marked.parse(accumulatedText);
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error('Groq Streaming Error:', err);
    answerContainer.textContent = 'Network or API error while streaming response.';
  }
}