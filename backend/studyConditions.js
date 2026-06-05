/**
 * Study Conditions Management
 * 
 * Handles three condition types for the study:
 * 1. 'control' - No extra prompting, no post-game review
 * 2. 'prompt-light' - Light prompting screen after game name, then text review
 * 3. 'prompt-ai' - AI-generated prompting with timeout, then AI review
 */

class StudyConditions {
  constructor() {
    this.enabled = false;
    this.username = null;
    this.conditionOrder = [];      // [condition, condition, ...] for 6 sessions
    this.currentSessionNumber = 0; // 0-5, which session we're on
    this.currentCondition = null;  // 'control', 'prompt-light', or 'prompt-ai'
    this.awsManager = null;
    this.cliOverride = null;       // CLI flag override for testing
  }

  /**
   * Initialize study mode with username and AWS manager
   */
  async initialize(username, awsManager, cliOverride = null) {
    this.username = username;
    this.awsManager = awsManager;
    this.cliOverride = cliOverride;
    
    if (this.cliOverride) {
      console.log(`📋 Study mode: Using CLI override condition: ${this.cliOverride}`);
      this.currentCondition = this.cliOverride;
      this.enabled = true;
      return;
    }

    // Try to load condition order from S3
    try {
      await this.loadConditionOrderFromS3();
      this.enabled = true;
      console.log(`📋 Study mode enabled. Current session: ${this.currentSessionNumber}, Condition: ${this.currentCondition}`);
    } catch (err) {
      console.warn(`⚠️ Failed to load condition order from S3:`, err.message);
      this.enabled = false;
    }
  }

  /**
   * Load condition order file from S3
   * File structure: s3://bucket/participant/{username}/condition-order.json
   * Content: {
   *   "conditions": ["control", "prompt-light", "prompt-ai", "control", "prompt-light", "prompt-ai"],
   *   "currentSessionNumber": 0
   * }
   */
  async loadConditionOrderFromS3() {
    if (!this.awsManager) {
      throw new Error('AWS Manager not initialized');
    }

    try {
      const conditionData = await this.awsManager.loadJSON(
        this.username,
        'condition-order',
        'participant'
      );

      if (!conditionData || !conditionData.conditions || !Array.isArray(conditionData.conditions)) {
        throw new Error('Invalid condition order file format');
      }

      this.conditionOrder = conditionData.conditions;
      
      if (conditionData.currentSessionNumber !== undefined) {
        this.currentSessionNumber = conditionData.currentSessionNumber;
      }

      this.updateCurrentCondition();
    } catch (err) {
      throw new Error(`Could not load condition order: ${err.message}`);
    }
  }

  /**
   * Save updated session number and condition state to S3
   */
  async saveProgressToS3() {
    if (!this.enabled || !this.awsManager || this.cliOverride) {
      return; // Don't save progress when using CLI override
    }

    try {
      const conditionData = {
        conditions: this.conditionOrder,
        currentSessionNumber: this.currentSessionNumber,
        lastUpdated: new Date().toISOString(),
      };

      await this.awsManager.saveJSON(
        this.username,
        'condition-order',
        'participant',
        conditionData
      );

      console.log(`✅ Saved condition progress to S3: session ${this.currentSessionNumber}`);
    } catch (err) {
      console.error(`❌ Failed to save condition progress:`, err);
    }
  }

  /**
   * Advance to next session (call after session completes)
   */
  advanceSession() {
    if (!this.enabled) return;

    this.currentSessionNumber = Math.min(this.currentSessionNumber + 1, 5);
    this.updateCurrentCondition();
    this.saveProgressToS3().catch(err => console.error('Failed to save progress:', err));
  }

  /**
   * Update current condition based on session number
   */
  updateCurrentCondition() {
    if (this.conditionOrder.length > 0 && this.currentSessionNumber < 6) {
      this.currentCondition = this.conditionOrder[this.currentSessionNumber];
    }
  }

  /**
   * Get the current condition type
   */
  getCondition() {
    return this.currentCondition;
  }

  /**
   * Get session number (0-5)
   */
  getSessionNumber() {
    return this.currentSessionNumber;
  }

  /**
   * Check if study mode is enabled
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * Check if should show light prompting screen
   */
  shouldShowLightPrompt() {
    return this.currentCondition === 'prompt-light';
  }

  /**
   * Check if should show AI prompting screen
   */
  shouldShowAIPrompt() {
    return this.currentCondition === 'prompt-ai';
  }

  /**
   * Check if should show post-game review
   */
  shouldShowReview() {
    return this.currentCondition !== 'control';
  }

  /**
   * Check if should show AI review (vs text review)
   */
  shouldShowAIReview() {
    return this.currentCondition === 'prompt-ai';
  }

  /**
   * Check if should show text review
   */
  shouldShowTextReview() {
    return this.currentCondition === 'prompt-light';
  }

  /**
   * Get inactivity timeout for AI prompt (in milliseconds)
   * Returns null if not applicable
   */
  getAIPromptTimeoutMs() {
    if (this.currentCondition === 'prompt-ai') {
      return 60000; // 60 seconds of inactivity before showing timeout prompt
    }
    return null;
  }

  /**
   * Check if we're still in the study (haven't completed all 6 sessions)
   */
  isStudyComplete() {
    return this.currentSessionNumber >= 5;
  }

  /**
   * Get human-readable condition name
   */
  getConditionLabel() {
    const labels = {
      'control': 'Control (no prompting, no review)',
      'prompt-light': 'Light Prompting + Text Review',
      'prompt-ai': 'AI Prompting + AI Review'
    };
    return labels[this.currentCondition] || 'Unknown';
  }
}

module.exports = StudyConditions;
