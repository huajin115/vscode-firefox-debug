import { Log } from '../util/log';
import { PendingRequest } from '../firefox/actorProxy/pendingRequests';

let log = Log.create('ThreadPauseCoordinator');

export type PauseType = 'auto' | 'user';

export class ThreadPauseCoordinator {

	private currentPauses: ThreadPauseInfo[] = [];
	private requestedPauses: PendingThreadPauseRequest[] = [];
	private requestedResumes: PendingThreadResumeRequest[] = [];
	private interruptingOrResumingThreadId?: number;

	public requestInterrupt(threadId: number, threadName: string, pauseType: PauseType): Promise<void> {

		if (log.isDebugEnabled()) {
			log.debug(`Requesting ${pauseType} interrupt for ${threadName}`);
		}

		if (this.findPauseIndex(threadId) !== undefined) {
			log.warn(`Requesting ${threadName} to be interrupted but it seems to be paused already`);
			return Promise.resolve(undefined);
		}

		let promise = new Promise<void>((resolve, reject) => {
			let pendingRequest = { resolve, reject };
			this.requestedPauses.push({ threadId, threadName, pauseType, pendingRequest });
		});

		this.doNext();

		return promise;
	}

	public requestResume(threadId: number, threadName: string): Promise<void> {

		if (log.isDebugEnabled()) {
			log.debug(`Requesting resume for ${threadName}`);
		}

		let pauseIndex = this.findPauseIndex(threadId);

		if (pauseIndex === undefined) {
			log.warn(`Requesting ${threadName} to be resumed but it doesn't seem to be paused`);
			return Promise.resolve();
		}

		if (this.currentPauses[pauseIndex].pauseType === 'user') {
			let hinderingPauses = this.findHinderingPauses(threadId);
			if (hinderingPauses.length > 0) {
				let msg = `${threadName} can't be resumed because you need to resume ${hinderingPauses.map((pauseInfo) => pauseInfo.threadName).join(', ')} first`;
				log.info(msg);
				return Promise.reject(msg);
			}
		}

		let promise = new Promise<void>((resolve, reject) => {
			let pendingRequest = { resolve, reject };
			this.requestedResumes.push({ threadId, threadName, pendingRequest });
		});

		this.doNext();

		return promise;
	}

	public notifyInterrupted(threadId: number, threadName: string, pauseType: PauseType): void {

		if (log.isDebugEnabled()) {
			log.debug(`${threadName} interrupted, type ${pauseType}`);
		}

		if (this.interruptingOrResumingThreadId === threadId) {
			this.interruptingOrResumingThreadId = undefined;
		}

		if (this.findPauseIndex(threadId) === undefined) {

			this.currentPauses.push({ threadId, threadName, pauseType });

			if (this.interruptingOrResumingThreadId !== undefined) {
				log.warn(`Received paused notification from ${threadName} while waiting for a notification from another thread`);
			}
		}

		this.doNext();
	}

	public notifyInterruptFailed(threadId: number, threadName: string): void {

		if (log.isDebugEnabled()) {
			log.debug(`Interrupting ${threadName} failed`);
		}

		if (this.interruptingOrResumingThreadId === threadId) {
			this.interruptingOrResumingThreadId = undefined;
		}

		let pauseIndex = this.findPauseIndex(threadId);
		if (pauseIndex !== undefined) {
			this.currentPauses.splice(pauseIndex, 1);
		}
	}

	public notifyResumed(threadId: number, threadName: string): void {

		if (log.isDebugEnabled()) {
			log.debug(`${threadName} resumed`);
		}

		let pauseIndex = this.findPauseIndex(threadId);

		if (pauseIndex === undefined) {

			log.warn(`Received resumed notification from ${threadName} but it doesn't seem to be paused`);

		} else if (pauseIndex === this.currentPauses.length - 1) {

			this.currentPauses.pop();

		} else {

			log.warn(`Received resumed notification from ${threadName} even though it is not the most recently paused thread`);
			this.currentPauses.splice(pauseIndex, 1);

		}

		if (this.interruptingOrResumingThreadId === threadId) {
			this.interruptingOrResumingThreadId = undefined;
		} else if (this.interruptingOrResumingThreadId !== undefined) {
			log.warn(`Received resumed notification from ${threadName} while waiting for a notification from another thread`);
		}

		this.doNext();
	}

	public notifyResumeFailed(threadId: number, threadName: string): void {

		if (log.isDebugEnabled()) {
			log.debug(`Resuming ${threadName} failed`);
		}

		if (this.interruptingOrResumingThreadId === threadId) {
			this.interruptingOrResumingThreadId = undefined;
		}
	}

	private doNext(): void {

		if (this.interruptingOrResumingThreadId !== undefined) {
			return;
		}

		if (log.isDebugEnabled()) {
			log.debug(`Current pauses: [${
				this.currentPauses.map((info) => info.threadName + '/' + info.pauseType).join(',')
			}], requested pauses: [${
				this.requestedPauses.map((info) => info.threadName + '/' + info.pauseType).join(',')
			}], requested resumes: [${
				this.requestedResumes.map((info) => info.threadName).join(',')
			}]`);
		}

		if (this.currentPauses.length > 0) {

			let mostRecentPause = this.currentPauses[this.currentPauses.length - 1];

			let resumeRequestIndex = this.findResumeRequestIndex(mostRecentPause.threadId);
			if (resumeRequestIndex !== undefined) {
				this.resumeThread(resumeRequestIndex);
				return;
			}

			if (mostRecentPause.pauseType === 'auto') {

				let automaticPauseRequestIndex = this.findAutomaticPauseRequestIndex();
				if (automaticPauseRequestIndex !== undefined) {
					this.pauseThread(automaticPauseRequestIndex);
				}

				return;
			}
		}

		//TODO should we block requested pauses if there is a resume waiting?
		if (this.requestedPauses.length > 0) {
			this.pauseThread(this.requestedPauses.length - 1);
		}
	}

	private pauseThread(pauseRequestIndex: number) {

		let pauseRequest = this.requestedPauses[pauseRequestIndex];
		log.debug(`Interrupting ${pauseRequest.threadName}`);

		this.requestedPauses.splice(pauseRequestIndex, 1);

		if (this.findPauseIndex(pauseRequest.threadId) === undefined) {

			this.currentPauses.push({ 
				threadId: pauseRequest.threadId, 
				threadName: pauseRequest.threadName, 
				pauseType:pauseRequest.pauseType
			});

			this.interruptingOrResumingThreadId = pauseRequest.threadId;

		} else {
			log.warn(`Executing pause request for ${pauseRequest.threadName} but it seems to be paused already`);
		}

		pauseRequest.pendingRequest.resolve(undefined);
	}

	private resumeThread(resumeRequestIndex: number) {

		let resumeRequest = this.requestedResumes[resumeRequestIndex];
		log.debug(`Resuming ${resumeRequest.threadName}`);

		this.requestedResumes.splice(resumeRequestIndex, 1);

		this.interruptingOrResumingThreadId = resumeRequest.threadId;

		resumeRequest.pendingRequest.resolve(undefined);
	}

	private findPauseIndex(threadId: number): number | undefined {

		for (let i = this.currentPauses.length - 1; i >= 0; i--) {
			if (this.currentPauses[i].threadId === threadId) {
				return i;
			}
		}

		return undefined;
	}

	private findResumeRequestIndex(threadId: number): number | undefined {

		for (let i = 0; i < this.requestedResumes.length; i++) {
			if (this.requestedResumes[i].threadId === threadId) {
				return i;
			}
		}

		return undefined;
	}

	private findAutomaticPauseRequestIndex(): number | undefined {

		for (let i = 0; i < this.requestedPauses.length; i++) {
			if (this.requestedPauses[i].pauseType === 'auto') {
				return i;
			}
		}

		return undefined;
	}

	private findHinderingPauses(resumeThreadId: number): ThreadPauseInfo[] {

		let hinderingPauses: ThreadPauseInfo[] = [];

		for (let i = this.currentPauses.length - 1; i >= 0; i--) {

			let pause = this.currentPauses[i];

			if (pause.threadId === resumeThreadId) {
				break;
			}

			if (pause.pauseType === 'user') {
				hinderingPauses.push(pause);
			}
		}

		return hinderingPauses;
	}
}

interface ThreadPauseInfo {
	threadId: number;
	threadName: string;
	pauseType: PauseType;
}

interface PendingThreadPauseRequest extends ThreadPauseInfo {
	pendingRequest: PendingRequest<void>;
}

interface PendingThreadResumeRequest {
	threadId: number;
	threadName: string;
	pendingRequest: PendingRequest<void>;
}
