import mongoose from 'mongoose';

const counterSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  seq:  { type: Number, default: 0 },
});

counterSchema.statics.nextSequence = async function (name) {
  const doc = await this.findOneAndUpdate(
    { name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
};

export default mongoose.models.Counter || mongoose.model('Counter', counterSchema);
