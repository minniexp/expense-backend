const mongoose = require('mongoose');

/**
 * A person who can appear on trips.
 *
 * Deliberately NOT the `User` model. Users are authenticated accounts with Google sign-in and
 * an approval flag; trip members are friends and family who will never log in. Conflating them
 * would mean creating login-capable accounts for people who only need to appear in a split.
 *
 * The roster is reusable so "Mom" is one person across every trip. Typing names per trip would
 * let "Sharon" and "sharon" become two people who then owe each other money.
 */
const tripMemberSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  // Optional tie-back to an existing id (MONGODB_USERID / MOMID / DADID) for members who also
  // appear in the main ledger.
  linkedUserId: { type: String, default: null },
  color: { type: String, default: '' },      // avatar tint in the UI
  archived: { type: Boolean, default: false }, // hidden from pickers, kept for historical trips
  notes: { type: String, default: '' },
}, { timestamps: true });

// Case-insensitive uniqueness: "Sharon" and "sharon" must not become two people.
tripMemberSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

module.exports = mongoose.models.TripMember || mongoose.model('TripMember', tripMemberSchema);
