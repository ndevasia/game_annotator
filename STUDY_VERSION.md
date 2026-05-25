# Game Annotator Study Version

## Overview

This application now supports a within-subjects study design with 6 sessions, where each participant experiences 2 sessions of each of 3 conditions:

1. **Control** (`control`) - No extra prompting, no post-game review
2. **Light Prompting** (`prompt-light`) - Light prompting screen with tips, followed by text review
3. **AI Prompting** (`prompt-ai`) - AI-generated suggestions for annotations, followed by AI review

## Architecture

### New Files Created

1. **`backend/studyConditions.js`** - Core study conditions management system
   - Tracks which condition each participant is in
   - Manages progression through 6 sessions
   - Loads condition order from S3 or accepts CLI overrides
   - Provides methods to check current condition state

2. **`prompt-light.html`** - Light prompting screen
   - Shows bullet points about what to annotate
   - User confirms to start recording

3. **`prompt-ai.html`** - AI prompting screen
   - Displays AI-generated suggestions for the specific game
   - Shows loading state while AI generates suggestions
   - Falls back to defaults if AI unavailable or times out

### Modified Files

1. **`main.js`** - Main process updates
   - Added StudyConditions initialization
   - Added CLI flag parsing for `--condition=<type>`
   - Modified session flow to show prompts before recording
   - Added prompt window creation and handlers
   - Integrated condition checks into review window selection
   - Added session progression tracking after reviews

2. **`backend/aws.js`** - Added S3 support
   - New `saveJSON()` method for saving arbitrary JSON to S3
   - Enables saving condition order and progress

3. **`backend/geminiService.js`** - Added AI suggestions
   - New `generateAnnotationSuggestions()` method
   - Generates game-specific annotation tips via Gemini API

4. **`package.json`** - Added new npm scripts
   - `npm run start:control` - Test control condition
   - `npm run start:prompt-light` - Test light prompt condition
   - `npm run start:prompt-ai` - Test AI prompt condition

## Usage

### Testing Individual Conditions

Use npm scripts to test each condition:

```bash
# Test control condition
npm run start:control

# Test light prompting condition  
npm run start:prompt-light

# Test AI prompting condition
npm run start:prompt-ai

# Normal mode (non-study)
npm start
```

### Production Study Mode

When study mode is enabled, the app will:

1. Check if a condition order file exists in S3 at:
   ```
   s3://bucket/{username}/participant/condition-order.json
   ```

2. Expected file format:
   ```json
   {
     "conditions": [
       "control",
       "prompt-light", 
       "prompt-ai",
       "control",
       "prompt-light",
       "prompt-ai"
     ],
     "currentSessionNumber": 0
   }
   ```

3. After each session completes (review submitted/skipped):
   - Session number advances
   - Progress is saved back to S3
   - User is informed which session they're on

4. After 6 sessions complete:
   - Study is marked complete
   - User cannot proceed to additional sessions

### Fallback Behavior

- If S3 condition file cannot be loaded and no CLI flag provided: Study mode disabled, app runs in normal mode
- If AI service unavailable: Default prompts shown in AI prompt screen
- If Gemini API call times out: Default prompts shown

## Condition Flow

### Control Condition Flow
```
User presses "Start Session"
↓
Enter game name (start.html)
↓
Start FFmpeg recording immediately
↓
Annotate gameplay
↓
Session ends, return to home (no review)
```

### Light Prompt Condition Flow
```
User presses "Start Session"
↓
Enter game name (start.html)
↓
Show prompting tips (prompt-light.html)
↓
User confirms
↓
Start FFmpeg recording
↓
Annotate gameplay
↓
Session ends, show text review (review-text.html)
↓
Return to home
```

### AI Prompt Condition Flow
```
User presses "Start Session"
↓
Enter game name (start.html)
↓
Show AI-generated tips (prompt-ai.html)
  ├─ Sends game title to Gemini
  ├─ Displays AI suggestions while user reviews them
  └─ Falls back to defaults if needed
↓
User confirms
↓
Start FFmpeg recording
↓
Annotate gameplay (with 60-second inactivity prompts if AI enabled)
↓
Session ends, show AI review (review-ai.html)
↓
Return to home
```

## Developer Notes

### Adding Session Progression Display

To show study progress to users, you can add this to `home.html`:

```javascript
const { ipcRenderer } = require('electron');

// Get study conditions info
ipcRenderer.invoke('get-study-conditions').then(conditions => {
  if (conditions.enabled) {
    console.log(`Session ${conditions.sessionNumber}/6 - ${conditions.conditionLabel}`);
  }
});
```

Add to `main.js`:

```javascript
ipcMain.handle('get-study-conditions', () => {
  return {
    enabled: studyConditions.isEnabled(),
    sessionNumber: studyConditions.getSessionNumber() + 1,
    conditionLabel: studyConditions.getConditionLabel(),
    isComplete: studyConditions.isStudyComplete()
  };
});
```

### S3 File Structure

The app expects this S3 structure for study mode:

```
s3://bucket/
├── username/
│   ├── videos/
│   ├── annotations/
│   ├── metadata/
│   └── participant/
│       └── condition-order.json
```

The `participant/` folder stores study-specific metadata.

## Testing Checklist

- [ ] Test control condition - no prompts, no review shown
- [ ] Test light prompt condition - light prompt appears, text review shown
- [ ] Test AI prompt condition - AI suggestions load, AI review shown
- [ ] Test CLI flags override S3 conditions
- [ ] Test session progression counter increments
- [ ] Test with AI unavailable (fallback to defaults)
- [ ] Test with S3 unavailable (normal mode)
- [ ] Test all 6 sessions complete (study completion message)
- [ ] Test annotations save in all conditions
- [ ] Test reviews save in conditions that show them

## API Keys Required

For AI suggestions to work, ensure `.env` or environment variables include:

```
GEMINI_API_KEY=your_key_here
```

Without this, AI suggestions will show default tips.

## Future Enhancements

1. Add inactivity timeout prompts during AI prompt sessions
2. Add visual study progress indicator (e.g., "Session 3 of 6")
3. Add condition description panel in home screen
4. Add ability to download study progress report
5. Add per-condition analytics dashboard
