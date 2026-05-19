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
    this.questionPhase = 0; // Track which phase of questioning
    this.questionCount = 0;
    this.questionsInPhase = 0; // Track questions within current phase (max 2 per phase)
  }

  /**
   * Initialize with context and get the first question
   * @param {string} gameTitle - The title of the game played
   * @param {string} sessionNotes - Notes/annotations from the session
   * @returns {Promise<string>} The first question to ask
   */
  async initializeAndGetFirstQuestion(gameTitle, sessionNotes = '') {
    this.gameTitle = gameTitle;
    this.sessionNotes = sessionNotes;
    this.conversationHistory = [];
    this.questionPhase = 0;
    this.questionCount = 0;
    this.questionsInPhase = 0;

    const notesContext = sessionNotes ? `\n\nPlayer's session notes: ${sessionNotes}` : '';
    
    const prompt = `You are a thoughtful game experience analyst. The player just finished playing "${gameTitle}".${notesContext}

Your role is to conduct a structured post-game reflection interview.

For the FIRST question, ask them to describe what they did during the gameplay.
This should be:
- Open-ended and encourage them to narrate their gameplay
- Focused on the descriptive level (what actions, what happened, what did they attempt?)
- Avoid asking about feelings/motivation yet - just the actions and gameplay flow
- Conversational and welcoming

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
   * @returns {Promise<{response: string, nextQuestion: string|null}>} Assistant response and next question (if any)
   */
  async sendMessageAndGetNextQuestion(userMessage) {
    // Add user message to history
    this.conversationHistory.push({
      role: 'user',
      parts: [{ text: userMessage }]
    });

    // Increment counters and manage phase progression
    this.questionCount++;
    
    // First response moves to phase 1
    if (this.questionCount === 2) {
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

    // Max of 10 questions for the interview (2 per phase across 5 phases)
    if (this.questionCount > 10) {
      return {
        response: '',
        nextQuestion: null
      };
    }

    const conversationText = this.conversationHistory
      .map(msg => `${msg.role === 'user' ? 'Player' : 'Assistant'}: ${msg.parts[0].text}`)
      .join('\n\n');

    const notesContext = this.sessionNotes ? `\n\nPlayer's session notes: ${this.sessionNotes}` : '';

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

Reference any session notes if relevant (${this.sessionNotes || 'no notes provided'}).
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

Reference their earlier description and any session notes if relevant.
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
- Any "aha moments" or realizations?

Reference specific details from what they said earlier and session notes if relevant.`;
        break;

      case 4:
        // Critical Reflection
        phaseFocus = `Ask a Critical Reflection question.
In Fleck & Fitzpatrick's framework, Critical Reflection involves deeper analysis of values, impact, and meaning.
Focus on:
- What does this gameplay experience mean to them?
- How does it connect to their broader gaming interests or life?
- What was most meaningful or valuable about the experience?
- Any broader patterns or insights they noticed?

Reference the full conversation context and any session notes.`;
        break;
    }

    systemPrompt = `You are a thoughtful game experience analyst conducting a structured post-game reflection interview about "${this.gameTitle}".

Conversation so far:
${conversationText}${notesContext}

PHASE FOCUS:
${phaseFocus}

First, provide a brief acknowledgement of what they said (1-2 sentences, supportive and genuine).
Then, ask your next question based on the phase focus above.

Format your response as:
ACKNOWLEDGEMENT: [your response]
QUESTION: [your next question]`;

    try {
      const result = await this.model.generateContent(systemPrompt);
      const responseText = result.response.text();
      
      // Parse the response
      const ackMatch = responseText.match(/ACKNOWLEDGEMENT:\s*(.+?)(?=QUESTION:|$)/s);
      const qMatch = responseText.match(/QUESTION:\s*(.+?)$/s);
      
      const acknowledgement = ackMatch ? ackMatch[1].trim() : "Thank you for sharing that.";
      const nextQuestion = qMatch ? qMatch[1].trim() : null;

      // Add assistant response to history
      this.conversationHistory.push({
        role: 'model',
        parts: [{ text: acknowledgement }]
      });

      return {
        response: acknowledgement,
        nextQuestion: nextQuestion
      };
    } catch (error) {
      console.error('Error in sendMessageAndGetNextQuestion:', error);
      return {
        response: "Thank you for sharing that.",
        nextQuestion: null
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
}

module.exports = GeminiService;
