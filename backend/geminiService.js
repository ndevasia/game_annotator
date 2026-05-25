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
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    this.conversationHistory = [];
    this.gameTitle = '';
    this.sessionNotes = '';
    this.studyContext = {};  // Context from session start (mood, mind, etc.)
    this.questionPhase = 0; // Track which phase of questioning
    this.questionCount = 0;
    this.questionsInPhase = 0; // Track questions within current phase (max 2 per phase)
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

Your role is to conduct a structured post-game reflection interview.

For the FIRST question, ask them to describe what they did during the gameplay.
This should be:
- Open-ended and encourage them to narrate their gameplay
- Focused on the descriptive level (what actions, what happened, what did they attempt?)
- Avoid asking about feelings/motivation yet - just the actions and gameplay flow
- Conversational and welcoming
${thinkingContext ? '\n- You can reference what they were thinking about to make the question relevant to their context' : ''}

Generate ONLY the question text, nothing else.`;

    try {
      const result = await this.model.generateContent(prompt);
      const question = result.response.text().trim();
      this.questionPhase = 0;
      this.questionCount++;
      this.questionsInPhase = 1;
      return question;
    } catch (error) {
      console.error('Error generating first question:', error);
      return `Can you walk me through what you did when you played ${gameTitle}? What were the main things you worked on or attempted?`;
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
        phaseFocus = `Ask about what motivated them to play ${this.gameTitle} today.
Use Organismic Integration Theory concepts - explore whether their motivation was:
- Intrinsic (playing because they find it enjoyable, it aligns with their interests)
- Extrinsic (external pressure, achievement, competition)
- A combination of both

Reference any session notes if relevant (${this.sessionNotes || 'no notes provided'}).${thinkingContext ? ' Connect to what they mentioned they were thinking about.' : ''}
Ask a thoughtful, open-ended question about their motivation.`;
        break;

      case 2:
        // Dialogical Reflection - interaction with game mechanics
        phaseFocus = `Ask a Dialogical Reflection question about their interaction with the game.
In Fleck & Fitzpatrick's framework, Dialogical Reflection involves understanding the dialogue between the player and the game system.
Focus on:
- How they interacted with game mechanics
- What the game was telling them through its feedback
- How they responded to that feedback
- Any specific moments where they had to make choices or adapt

Reference their earlier description and any session notes if relevant.${thinkingContext ? ' Consider how what they were thinking about may have influenced their decisions.' : ''}
Ask about how the game's systems and their player actions created a back-and-forth dialogue.`;
        break;

      case 3:
        // Transformative Reflection
        phaseFocus = `Ask a Transformative Reflection question.
In Fleck & Fitzpatrick's framework, Transformative Reflection involves examining how their understanding or approach changed.
Focus on:
- Did they learn new strategies or skills?
- Did their approach change as they played?
- Did the experience shift how they think about the game or their gameplay?
- Any "aha moments" or realizations?${thinkingContext ? ' Did the game experience change or relate to what they were thinking about?' : ''}

Reference specific details from what they said earlier and session notes if relevant.`;
        break;

      case 4:
        // Critical Reflection
        phaseFocus = `Ask a Critical Reflection question.
In Fleck & Fitzpatrick's framework, Critical Reflection involves deeper analysis of values, impact, and meaning.
Focus on:
- What does this gameplay experience mean to them?
- How does it connect to their broader gaming interests or life?${thinkingContext ? ` Did it relate to what they were thinking about (${this.studyContext.mind})?` : ''}
- What was most meaningful or valuable about the experience?
- Any broader patterns or insights they noticed?

Reference the full conversation context, their mood context, and any session notes.`;
        break;
    }

    // Build the validation prompt - check if the answer is on-topic and substantive
    const lastQuestion = this.conversationHistory.length >= 3 
      ? this.conversationHistory[this.conversationHistory.length - 2].parts[0].text 
      : '';

    systemPrompt = `You are a thoughtful game experience analyst conducting a structured post-game reflection interview about "${this.gameTitle}".

Player Context:${moodContext}${thinkingContext}

Conversation so far:
${conversationText}${notesContext}

PHASE FOCUS:
${phaseFocus}

CRITICAL INSTRUCTION: Before proceeding, evaluate if the player's response adequately answers the question.

The last question asked: "${lastQuestion}"
The player's response: "${userMessage}"

Evaluate: Does the response meaningfully address the question? Is it substantive (not just "yes", "no", or off-topic)? Is it focused on the game experience they're being asked about?

If YES (response is valid and on-topic):
- Provide a brief acknowledgement of what they said (1-2 sentences, supportive and genuine)
- Then move to the next question based on the phase focus
- Format as:
VALID: true
ACKNOWLEDGEMENT: [your response]
QUESTION: [your next question]

If NO (response is off-topic, too brief, or doesn't address the question):
- Gently redirect them to stay on track
- Rephrase the original question or ask for clarification
- Encourage them to be more specific about the game experience
- Format as:
VALID: false
REDIRECT: [your redirect message asking them to refocus and answer the question more directly]`;

    try {
      const result = await this.model.generateContent(systemPrompt);
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
        response: "Could you tell me more about that? I want to make sure I understand your experience.",
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
      const prompt = `Based on this post-game review conversation about "${this.gameTitle}", provide a brief, encouraging closing message (1-2 sentences) thanking the player for their feedback and noting that you hope they continue to enjoy gaming.`;

      const result = await this.model.generateContent(prompt);
      return result.response.text().trim();
    } catch (error) {
      console.error('Error generating closing message:', error);
      return "Thank you for sharing your feedback! We appreciate your insights.";
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
