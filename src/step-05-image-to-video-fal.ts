import p from "node:process";
import { sleep } from "./util";
import { CacheOrComputer, WriteUtil} from "./util/api-cache";
import { fal } from "@fal-ai/client";
import fs from 'node:fs/promises';
import path from 'node:path';

type P = {
    RUNWAY_USERNAME: string;
    RUNWAY_PASSWORD: string;
    RUNWAY_COOKIE?: string;
    RUNWAY_TOKEN?: string;
    prompt: string;
    imageFilePath: string;
};
type Result = "refused-content-error" | "ok";

async function processA(props: P, util: WriteUtil): Promise<Result> {
    try {
        const inputFile = path.resolve(p.cwd(), props.imageFilePath);
        const fileBuffer = await fs.readFile(inputFile);
        const base64Image = fileBuffer.toString('base64');
        const mimeType = `image/${path.extname(props.imageFilePath).slice(1)}`;
        const imageUrl = `data:${mimeType};base64,${base64Image}`;

        const submission = await fal.queue.submit("fal-ai/stable-video", {
            input: {
                image_url: imageUrl,
                // prompt: props.prompt,
            },
        });
        const requestId = submission.request_id;
        console.log("Fal.ai request submitted with ID:", requestId);

        // Poll for status
        let status;
        do {
            await sleep(10000); // Wait for 10 seconds
            status = await fal.queue.status("fal-ai/stable-video", {
                requestId: requestId,
                logs: true,
            });
            console.log("Fal.ai request status:", status.status);
        } while (status.status !== "COMPLETED");

        if (status.status === "COMPLETED") {
            const result = await fal.queue.result("fal-ai/stable-video", {
                requestId: requestId,
            });
            console.log("Fal.ai result:", result);
            if (result?.data?.video.url) {
                const videoUrl = result.data.video.url;
                console.log("Downloading video from:", videoUrl);
                const response = await fetch(videoUrl);
                if (!response.ok) {
                    throw new Error(`Failed to download video: ${response.status} ${response.statusText}`);
                }
                const buffer = await response.arrayBuffer();
                await util.writeCompanion("-vid.mp4", new Uint8Array(buffer));
                return "ok";
            } else {
                console.error("Fal.ai result does not contain video_url");
                return "refused-content-error"; // Consider a more specific error type
            }
        } else {
            console.error("Fal.ai request failed");
            return "refused-content-error"; // Consider a more specific error type
        }
    } catch (error: any) {
        console.error("Error during Fal.ai processing:", error);
        return "refused-content-error"; // Or a more appropriate error
    }
}

export async function step05ImageToVideoFal(
    apiFromCacheOr: CacheOrComputer,
    config: {
        RUNWAY_USERNAME?: string;
        RUNWAY_PASSWORD?: string;
    },
    prompt: string,
    imageFilePath: string,
    preSleep: () => Promise<void>
) {
    if (!config.RUNWAY_PASSWORD || !config.RUNWAY_USERNAME)
        throw Error("no RUNWAY_PASSWORD or RUNWAY_USERNAME");
    const input = {
        prompt,
        imageFilePath,
    };
    const full = {
        RUNWAY_USERNAME: config.RUNWAY_USERNAME,
        RUNWAY_PASSWORD: config.RUNWAY_PASSWORD,
        ...input,
    };
    const result = await apiFromCacheOr(
        `https://fal.ai/api/stable-video`, // Changed the cache key to reflect the API being used
        input,
        async (util) => {
            await preSleep();
            const result = await processA(full, util);
            return {result};
        }
    );
    return {...result, videoFilePath: result.meta.cachePrefix + "-vid.mp4"};
}