import "source-map-support/register";

import axios from "axios";
import { createReadStream, createWriteStream, readdirSync, readFileSync, writeFileSync } from "fs";
import { ensureDirSync } from "fs-extra";
import { MongoClient } from "mongodb";
import { basename } from "path";
import { Extract } from "unzipper";

import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";

const octokit = new Octokit();

try {
	require("dotenv").config({ path: "../.env" });
} catch (e) {}

core.info("Updating Translations");
//* Create API Base
//* Run updater
const base = axios.create({
		baseURL: "https://api.crowdin.com/api/project/premid/"
	}),
	crowdinName = "[PreMiD.Localization] main";

run();

async function run() {
	//* Get latest translations
	//* Read translations/master/
	//* Map through lang folders
	await getLatestTranslations();
	core.info("Transforming result");
	const folders = readdirSync(`translations/${crowdinName}/`);
	const translations = folders.map(f => {
		//* Read projects inside lang Folder
		//* return mapped through projects
		const projects = readdirSync(`translations/${crowdinName}/${f}`);
		return projects.map(p => {
			//* Get files in project
			//* Return mapped through files
			const files = readdirSync(`translations/${crowdinName}/${f}/${p}`);
			return {
				//* If lang === de_DE > de else keep it
				//* Project
				//* Translations (Object assign to move into one big object)
				lang: f.slice(0, 2) === f.slice(3, 5).toLowerCase() ? f.slice(0, 2) : f,
				project: p.toLowerCase(),
				translations: Object.assign(
					{},
					//* Map through files
					...files.map(file => {
						//* Read json of file
						//* Return Object.assign > .map > 1 big object of all files
						const json = JSON.parse(
							readFileSync(
								`translations/${crowdinName}/${f}/${p}/${file}`,
								"utf-8"
							)
						);
						return Object.assign(
							{},
							//* Map through json and replace . with _ (MongoDB doesn't allow . key)
							...Object.keys(json).map(k => {
								return { [k.replace(/[.]/g, "_")]: json[k].message };
							})
						);
					})
				)
			};
		});
	});

	//* Connect to MongoDB
	//* Promise.all
	core.info("Connecting to MongoDB");
	const client = (await MongoClient.connect(
		`mongodb://${process.env.MONGOUSER}:${process.env.MONGOPASS}@${process.env.MONGOIP}:27017`,
		{ appname: "PreMiD - Translation Updater", useUnifiedTopology: true }
	).catch(err => {
		core.setFailed(`Failed to connect to MongoDB: ${err.message}`);
		process.exit();
	})) as MongoClient;
	Promise.all(
		translations
			.reduce((a, b) => [...a, ...b])
			.map(t =>
				client
					.db("PreMiD")
					.collection("langFiles")
					.replaceOne({ lang: t.lang, project: t.project }, t, { upsert: true })
			)
	).then(() => {
		core.info("Done!");
		client.close();
	});
}

async function getLatestTranslations() {
	//* Build project
	//* If error or no new translations, exit
	//* Else download them
	//* Unzip them
	const res = (
		await base("export", {
			params: { key: process.env.CROWDIN_API_TOKEN, json: true }
		})
	).data;
	/* 	if (!res.success || res.success.status === "skipped") {
		core.info("Already up to date");
		process.exit();
	} */
	core.info("Downloading translations...");
	const tZIPresponse = await base("download/all.zip", {
			responseType: "stream",
			params: { key: process.env.CROWDIN_API_TOKEN, json: true }
		}),
		zipFile = tZIPresponse.data.pipe(createWriteStream("translations.zip"));
	await new Promise((resolve, reject) => {
		zipFile.on("finish", resolve);
		zipFile.on("error", reject);
	});
	const extract = createReadStream("translations.zip").pipe(
		Extract({ path: "translations" })
	);
	await new Promise(resolve => extract.once("finish", resolve));
	await getSourceLanguage();
	core.info("Downloaded translations");
}

async function getSourceLanguage() {
	const srcFolder = (
		await octokit.repos.getContent({
			owner: "PreMiD",
			repo: "Localization",
			path: "src"
		})
	).data
		// @ts-ignore
		.map(f => f.path);

	await Promise.all(
		srcFolder.map(async p => {
			const projFolder = (
				await octokit.repos.getContent({
					owner: "PreMiD",
					repo: "Localization",
					path: p
				})
			).data
				// @ts-ignore
				.map(f => f.path);

			ensureDirSync(`translations/${crowdinName}/en/${basename(p)}`);

			await Promise.all(
				projFolder.map(async f => {
					writeFileSync(
						`translations/${crowdinName}/en/${basename(p)}/${basename(f)}`,
						JSON.stringify(
							(
								await axios.get(
									`https://raw.githubusercontent.com/PreMiD/Localization/master/${f}`
								)
							).data
						)
					);
				})
			);
		})
	);
}
