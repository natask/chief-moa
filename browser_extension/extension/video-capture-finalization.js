export async function finalizeActiveVideoCapture({
  capture,
  getActiveCapture,
  clearActiveCapture,
  stopRecorder,
}) {
  if (!capture || getActiveCapture() !== capture) return false;
  await stopRecorder(capture);
  if (getActiveCapture() === capture) clearActiveCapture();
  return true;
}
