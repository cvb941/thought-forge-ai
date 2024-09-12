import "dotenv/config";
import { promises as fs } from "fs";
import { step00FindTopic as step00FindTopics } from "./step-00-find-topic";
import { step01WriteScript as step01WriteMonologue } from "./step-01-write-monologue";
import { step02TextToSpeech, TTSResponseFinal } from "./step-02-text-to-speech";
import { step03TextToImagePrompt } from "./step-03-text-to-image-prompt";
import { step06TextToMusicPrompt } from "./step-06-text-to-music-prompt";
import { step07music } from "./step-07-music";
import { step08subtitles } from "./step-08-subtitles";
import { step09ffmpeg } from "./step-09-ffmpeg";
import {
  alignSpeech,
  alignVideo,
  ImageSpeechVideoAlignment,
} from "./util/align-video";
import { apiFromCacheOr } from "./util/api-cache";
import { StatsCounter, zeroStatsCounter } from "./util/stats";

function assertNonNull<T>(x: (T | null)[], e: string): asserts x is T[] {
  if (x.some((e) => e === null)) throw Error(e);
}
async function main() {
  const statsCounter = zeroStatsCounter();
  const config = process.env as any;
  const seed = 1352242560; // (Math.random() * Number.MAX_SAFE_INTEGER) | 0;
  const maxVideos = 40;
  const topics = await step00FindTopics(
    apiFromCacheOr,
    config,
    statsCounter,
    seed,
    maxVideos
  );
  console.log(
    "topics:\n",
    topics
      .map(
        (p, i) => `Topic ${i}: ${p.clickbait_title} (${p.topic}) (${p.voice})`
      )
      .join("\n")
  );
  const choice = +process.argv[2];
  if (isNaN(choice)) throw Error("no topic chosen");
  const topic = topics[choice];
  console.log("chosen topic", choice, topic);
  const projectDir = `data/videos/${choice
    .toString()
    .padStart(3, "0")} ${topic.clickbait_title.replace(/\//g, "")}/`;
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(projectDir + "topic.json", JSON.stringify(topic, null, 2));
  await fs.writeFile(projectDir + "seed.json", JSON.stringify(seed, null, 2));
  console.log("writing monologue");
  // having cook in there sometimes makes the AI think it should be about cooking.
  if (topic.voice === "cook") topic.voice = "kyana";
  const monologue = await step01WriteMonologue(
    apiFromCacheOr,
    config,
    statsCounter,
    topic
  );
  await fs.writeFile(projectDir + "monologue.txt", monologue);
  console.log("monologue", monologue);
  console.time("tts");
  const speech = await step02TextToSpeech(
    apiFromCacheOr,
    config,
    statsCounter,
    topic,
    monologue
  );
  await fs.copyFile(speech.speechFileName, projectDir + "speech.mp3");
  console.timeEnd("tts");
  console.time("image prompts");
  const iprompts = await step03TextToImagePrompt(
    apiFromCacheOr,
    config,
    statsCounter,
    monologue
  );
  console.timeEnd("image prompts");

  const pauseAfterSeconds = 1;
  const [videoAlignments, music] = await Promise.all([
    doVideo(projectDir, config, monologue, speech, iprompts, pauseAfterSeconds),
    doMusic(
      speech,
      monologue,
      projectDir,
      config,
      statsCounter,
      pauseAfterSeconds
    ),
  ]);

  const subtitleFileName = projectDir + "subtitles" + ".ass";
  await step08subtitles({ speech, outputFilename: subtitleFileName });
  const res = await step09ffmpeg(apiFromCacheOr, {
    speech: speech.speechFileName,
    subtitles: subtitleFileName,
    music: music.musicFileName,
    alignment: videoAlignments,
  });
  fs.copyFile(res.videoFileName, projectDir + "merged.mp4");
}

type Config = any;

async function doVideo(
  projectDir: string,
  config: Config,
  monologue: string,
  speech: TTSResponseFinal,
  iprompts: { text: string; prompt: string }[],
  pauseAfterSeconds: number
) {
  const alignment = alignSpeech(
    monologue,
    speech.data,
    iprompts,
    pauseAfterSeconds
  );
  const _videoAlignments: PromiseSettledResult<ImageSpeechVideoAlignment>[] =
    await alignVideo(alignment, config, projectDir);
  const videoAlignments = _videoAlignments.map((p) => {
    if (p.status === "fulfilled") return p.value;
    else throw Error("at least one video failed to generate");
  });

  console.log(videoAlignments);
  await fs.writeFile(
    projectDir + "alignments.json",
    JSON.stringify(videoAlignments, null, 2)
  );
  return videoAlignments;
}
async function doMusic(
  speech: TTSResponseFinal,
  monologue: string,
  projectDir: string,
  config: Config,
  statsCounter: StatsCounter,
  pauseAfterSeconds: number
) {
  const musicDuration =
    speech.data.alignment.character_end_times_seconds.slice(-1)[0] +
    pauseAfterSeconds;
  console.log("music duration", musicDuration);
  const musicPrompt = await step06TextToMusicPrompt(
    apiFromCacheOr,
    config,
    statsCounter,
    monologue,
    musicDuration
  );
  await fs.writeFile(projectDir + "music-prompt.txt", musicPrompt);
  const music = await step07music(
    apiFromCacheOr,
    config,
    musicPrompt,
    musicDuration
  );
  await fs.copyFile(music.musicFileName, projectDir + "music.mp3");
  return music;
}
void main();
