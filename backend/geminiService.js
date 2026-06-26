const { GoogleGenerativeAI } = require('@google/generative-ai');
const dotenv = require('dotenv');

dotenv.config();

class GeminiService {
  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }
    
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
    this.conversationHistory = [];
    this.gameTitle = '';
    this.sessionNotes = '';
    this.studyContext = {};  // Context from session start (mood, mind, etc.)
    this.questionPhase = 0; // Track which phase of questioning
    this.questionCount = 0;
    this.questionsInPhase = 0; // Track questions within current phase (max 2 per phase)
    this.requestTimeout = 10000; // 10 second timeout for API requests
    this.maxRetries = 2; // Retry up to 2 times if timeout occurs
  }

  /**
   * Generate content with timeout and retry logic with exponential backoff for rate limit/service errors
   * @param {string} prompt - The prompt to send
   * @returns {Promise<object>} The response object
   */
  async generateWithTimeout(prompt) {
    let lastError;
    const maxRetries = 5; // Increased for rate limit/service errors
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('API request timeout')), this.requestTimeout)
        );
        
        const result = await Promise.race([
          this.model.generateContent(prompt),
          timeoutPromise
        ]);
        
        return result;
      } catch (error) {
        lastError = error;
        const isRetryable = this.isRetryableError(error);
        
        if (!isRetryable) {
          throw error;
        }
        
        if (attempt < maxRetries - 1) {
          const errorCode = error.status || error.code || 'unknown';
          const delay = this.getBackoffDelay(attempt, errorCode);
          console.warn(`Retryable error (${errorCode}) on attempt ${attempt + 1}/${maxRetries}. Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Determine if an error is retryable
   */
  isRetryableError(error) {
    const errorCode = error.status || error.code;
    // Retry on: timeout, 429 (TooManyRequests), 503 (ServiceUnavailable), 500-599 (server errors)
    if (error.message === 'API request timeout') return true;
    if (errorCode === 429 || errorCode === 503) return true;
    if (errorCode >= 500 && errorCode < 600) return true;
    return false;
  }

  /**
   * Calculate backoff delay with exponential growth
   */
  getBackoffDelay(attempt, errorCode) {
    let baseDelay = 500; // Base delay in ms
    
    // Rate limit (429) gets more aggressive backoff
    if (errorCode === 429) {
      baseDelay = 2000; // Start with 2 seconds for rate limits
    }
    
    // Exponential backoff: 500ms, 1s, 2s, 4s, 8s (for normal errors)
    // Or: 2s, 4s, 8s, 16s, 32s (for rate limits)
    const delay = baseDelay * Math.pow(2, attempt);
    
    // Cap at 15 seconds max
    return Math.min(delay, 15000);
  }

  /**
   * Detect meaningful themes in user's response
   * Themes: 1) Interest-driven learning, 2) Inward-focused changes, 3) Career, 4) Physical/mental health, 5) Meaningful social connections
   */
  detectThemes(userMessage) {
    const detectedThemes = [];
    const messageLower = userMessage.toLowerCase();

    // Theme 1: Interest-driven learning (real-world learning inspired by the game)
    const learningKeywords = /inspired.*to learn|want to learn|got me interested in|made me want to|thinking about learning|curious about.*in real life|interested in.*outside|learning about.*real|want to try|want to practice|got me thinking about learning/i;
    if (learningKeywords.test(userMessage)) {
      detectedThemes.push('interest-driven learning');
    }

    // Theme 2: Inward-focused changes (self-perception, worldview)
    const inwardKeywords = /change.*perspective|saw.*differently|think.*different|understand.*myself|better at|more confident|less confident|my approach|my thinking|perspective|mindset|realized about|rediscover/i;
    if (inwardKeywords.test(userMessage)) {
      detectedThemes.push('inward-focused changes');
    }

    // Theme 3: Career
    const careerKeywords = /job|career|work|professional|skills|resume|interview|promotion|salary|industry|business|entrepreneurship|freelance|portfolio/i;
    if (careerKeywords.test(userMessage)) {
      detectedThemes.push('career');
    }

    // Theme 4: Physical or mental health
    const healthKeywords = /stress|anxiety|mental|health|relaxation|physical|exercise|sleep|calm|focus|concentrate|pressure|tired|fatigue|mindful/i;
    if (healthKeywords.test(userMessage)) {
      detectedThemes.push('physical or mental health');
    }

    // Theme 5: Meaningful social connections
    const socialKeywords = /friend|family|people|social|together|community|team|group|relationship|connection|community|alone|lonely|interact|cooperate|team|multiplayer|online|together/i;
    if (socialKeywords.test(userMessage)) {
      detectedThemes.push('meaningful social connections');
    }

    return detectedThemes;
  }

  /**
   * Initialize with context and get the first question
   * @param {string} gameTitle - The title of the game played
   * @param {string} sessionNotes - Notes/annotations from the session
   * @param {object} studyContext - Study session context (mood, mind from session start)
   * @returns {Promise<string>} The first question to ask
   */
  async initializeAndGetFirstQuestion(gameTitle, sessionNotes = '', studyContext = {}) {
    this.gameTitle = gameTitle;
    this.sessionNotes = sessionNotes;
    this.studyContext = studyContext;  // Store context for use in later questions
    this.conversationHistory = [];
    this.questionPhase = 0;
    this.questionCount = 0;
    this.questionsInPhase = 0;

    const notesContext = sessionNotes ? `\n\nPlayer's session notes: ${sessionNotes}` : '';
    const thinkingContext = studyContext.mind ? `\n\nBefore playing, they were thinking about: ${studyContext.mind}` : '';
    const moodContext = studyContext.mood ? `\n\nTheir mood today: ${studyContext.mood}` : '';
    
    const prompt = `You are a thoughtful game experience analyst. The player just finished playing "${gameTitle}".${notesContext}${moodContext}${thinkingContext}

For the FIRST question, ask them to describe what they did during the gameplay.
This should be:
- 2-3 sentences max, conversational
- Open-ended about their gameplay actions
- Welcoming and engaging

Generate ONLY the question text, nothing else.`;

    try {
      const result = await this.generateWithTimeout(prompt);
      const question = result.response.text().trim();
      this.questionPhase = 0;
      this.questionCount++;
      this.questionsInPhase = 1;
      return question;
    } catch (error) {
      console.error('Error generating first question:', error);
      return `What did you do in ${gameTitle}?`;
    }
  }

  /**
   * Get the full conversation transcript
   * @returns {Array} The complete conversation messages
   */
  getConversationTranscript() {
    return this.conversationHistory.map(msg => ({
      role: msg.role === 'user' ? 'player' : 'ai',
      text: msg.parts[0].text
    }));
  }

  /**
   * Send a message and get the next question (or closing remarks)
   * @param {string} userMessage - The player's response
   * @returns {Promise<{response: string, nextQuestion: string|null, countedAsQuestion: boolean}>} Assistant response, next question, and whether it counted
   */
  async sendMessageAndGetNextQuestion(userMessage) {
    // Add user message to history
    this.conversationHistory.push({
      role: 'user',
      parts: [{ text: userMessage }]
    });

    // Detect meaningful themes in the user's response
    const detectedThemes = this.detectThemes(userMessage);

    // Max of 10 valid questions for the interview (2 per phase across 5 phases)
    if (this.questionCount >= 10) {
      return {
        response: '',
        nextQuestion: null,
        countedAsQuestion: false,
        interviewComplete: true
      };
    }

    const conversationText = this.conversationHistory
      .map(msg => `${msg.role === 'user' ? 'Player' : 'Assistant'}: ${msg.parts[0].text}`)
      .join('\n\n');

    const notesContext = this.sessionNotes ? `\n\nPlayer's session notes: ${this.sessionNotes}` : '';
    const thinkingContext = this.studyContext.mind ? `\n\nPlayer was thinking about: ${this.studyContext.mind}` : '';
    const moodContext = this.studyContext.mood ? `\n\nPlayer's mood: ${this.studyContext.mood}` : '';

    let phaseFocus = '';
    let systemPrompt = '';

    switch (this.questionPhase) {
      case 1:
        // Organismic Integration Theory - motivation phase
        phaseFocus = `Ask about what motivated their gameplay today. Explore whether it was intrinsic (enjoyment, interest) or extrinsic (goals, external pressure) or a mix of both.`;
        break;

      case 2:
        // Dialogical interaction with game mechanics
        phaseFocus = `Ask about how they interacted with the game's mechanics, feedback systems, and how they responded to what the game told them.`;
        break;

      case 3:
        // Endo-game transformation (behavior change)
        phaseFocus = `Ask if they learned anything, changed their approach, or had any "aha moments" while playing.`;
        break;

      case 4:
        // Connection to exo-game insights or realizations
        phaseFocus = `Ask what was most meaningful or valuable about their experience and how it connects to their broader gaming interests.`;
        break;
    }

    // Build the validation prompt - check if the answer is on-topic and substantive
    const lastQuestion = this.conversationHistory.length >= 3 
      ? this.conversationHistory[this.conversationHistory.length - 2].parts[0].text 
      : '';

    systemPrompt = `You are a thoughtful educator conducting a post-game reflection interview about "${this.gameTitle}".

Player Context:${moodContext}${thinkingContext}

Conversation so far:
${conversationText}${notesContext}

Evaluate if the player's response adequately answers: "${lastQuestion}"

IMPORTANT THEMES TO EXPLORE:
If the player mentions any of these themes, prioritize asking a follow-up question about them:
- Interest-driven learning (wanting to learn something new, discovering skills or strategies)
- Inward-focused changes (shifts in self-perception, changes in worldview or approach)
- Career (professional growth, skills that apply to work, job-related insights)
- Physical or mental health (relaxation, stress relief, focus, mental clarity)
- Meaningful social connections (playing with/for others, community, teamwork)

Detected themes in their response: ${detectedThemes.length > 0 ? detectedThemes.join(', ') : 'none'}

If YES (response is valid and substantive - not just "yes"/"no"):
- Provide a brief acknowledgement (2-3 sentences, reflect back what they said)
- Ask ONE next question based on this focus: ${phaseFocus}
${detectedThemes.length > 0 ? `- PRIORITIZE: Try to incorporate or follow up on the detected theme(s): ${detectedThemes.join(', ')}` : ''}
- The question should be thoughtful and natural (2-3 sentences max)
- Format as:
VALID: true
ACKNOWLEDGEMENT: [your response]
QUESTION: [your next question - SINGLE QUESTION ONLY]

If NO (response is off-topic, too brief, or doesn't address the question):
- Gently redirect them (1-2 sentences)
- Format as:
VALID: false
REDIRECT: [your redirect message]`;

    try {
      const result = await this.generateWithTimeout(systemPrompt);
      const responseText = result.response.text();
      
      // Parse the response
      const validMatch = responseText.match(/VALID:\s*(true|false)/i);
      const isValid = validMatch ? validMatch[1].toLowerCase() === 'true' : true; // Default to true if not specified
      
      if (isValid) {
        // Valid answer - count it and advance
        const ackMatch = responseText.match(/ACKNOWLEDGEMENT:\s*(.+?)(?=QUESTION:|$)/s);
        const qMatch = responseText.match(/QUESTION:\s*(.+?)$/s);
        
        const acknowledgement = ackMatch ? ackMatch[1].trim() : "Thank you for sharing that.";
        const nextQuestion = qMatch ? qMatch[1].trim() : null;

        // Increment counters and manage phase progression
        this.questionCount++;
        
        // First response moves to phase 1
        if (this.questionCount === 1) {
          this.questionPhase++;
          this.questionsInPhase = 1;
        } else {
          this.questionsInPhase++;
          // After 2 questions in current phase, increment phase
          if (this.questionsInPhase > 2 && this.questionPhase < 4) {
            this.questionPhase++;
            this.questionsInPhase = 1;
          }
        }

        // Add assistant response to history
        this.conversationHistory.push({
          role: 'model',
          parts: [{ text: acknowledgement }]
        });

        return {
          response: acknowledgement,
          nextQuestion: nextQuestion,
          countedAsQuestion: true,
          interviewComplete: false
        };
      } else {
        // Invalid answer - redirect without counting
        const redirectMatch = responseText.match(/REDIRECT:\s*(.+?)$/s);
        const redirect = redirectMatch ? redirectMatch[1].trim() : "I'd like you to focus on the game experience. Could you tell me more about what happened in the game?";

        // Add redirect to history (as assistant response, not as a new question)
        this.conversationHistory.push({
          role: 'model',
          parts: [{ text: redirect }]
        });

        return {
          response: redirect,
          nextQuestion: null,
          countedAsQuestion: false,
          interviewComplete: false
        };
      }
    } catch (error) {
      console.error('Error in sendMessageAndGetNextQuestion:', error);
      return {
        response: "Tell me more about that.",
        nextQuestion: null,
        countedAsQuestion: false,
        interviewComplete: false
      };
    }
  }

  /**
   * Generate a closing message
   * @returns {Promise<string>} Closing message
   */
  async generateClosingMessage() {
    try {
      const prompt = `Based on this post-game review conversation about "${this.gameTitle}", provide a brief, encouraging closing message (2-3 sentences) thanking the player for their feedback and their participation.`;

      const result = await this.generateWithTimeout(prompt);
      return result.response.text().trim();
    } catch (error) {
      console.error('Error generating closing message:', error);
      return "Thank you for sharing your feedback with such thoughtful responses. We really appreciate your insights!";
    }
  }

  /**
   * Reset conversation history
   */
  resetConversation() {
    this.conversationHistory = [];
    this.questionPhase = 0;
    this.questionCount = 0;
    this.questionsInPhase = 0;
  }

  /**
   * Generate AI-powered annotation suggestions based on game title
   * @param {string} gameTitle - The title of the game
   * @returns {Promise<Array>} Array of suggestion objects with category and text
   */
  async generateAnnotationSuggestions(gameTitle) {
    try {
      const prompt = `You are an expert game experience analyst. For the game "${gameTitle}", suggest 5-6 key topics or events that a player might want to annotate during gameplay.

Each suggestion should help the player capture interesting moments or learning opportunities specific to this type of game.

Respond with a JSON array where each item has:
- "category": A short category name (3-5 words)
- "text": A brief explanation of what to look for (10-20 words)

For example:
[
  {
    "category": "Resource Management",
    "text": "Moments where you allocate or run out of in-game resources"
  }
]

Be specific to "${gameTitle}" and provide practical, actionable suggestions.
Respond ONLY with valid JSON array, nothing else.`;

      const result = await this.model.generateContent(prompt);
      const responseText = result.response.text().trim();
      
      try {
        // Try to parse as JSON
        const suggestions = JSON.parse(responseText);
        if (Array.isArray(suggestions) && suggestions.length > 0) {
          // Validate structure
          return suggestions.filter(s => s.category && s.text);
        }
      } catch (parseErr) {
        console.warn('Could not parse AI suggestions as JSON, falling back to defaults');
      }
      
      return null; // Will trigger default suggestions in frontend
    } catch (error) {
      console.error('Error generating annotation suggestions:', error);
      return null; // Will trigger default suggestions in frontend
    }
  }
}

module.exports = GeminiService;
