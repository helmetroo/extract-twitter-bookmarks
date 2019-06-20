import { Page } from 'puppeteer';
import { OrderedSet } from 'immutable';
import { from, fromEvent, merge, Subscription, Observer, Observable } from 'rxjs';
import { flatMap, reduce, takeWhile, map, switchMap, tap } from 'rxjs/operators';

import Tweet from './interfaces/tweet';
import TweetSet from './interfaces/tweet-set';
import ProgressEventEmitter, {
    ProgressableEvent, ProgressEvent, MessageEvent
} from './interfaces/progress-event-emitter';
import Progressable from './interfaces/progressable';
import ErrorCallback from './interfaces/error-callback';
import PageManagerOptions from './interfaces/bookmarks-page-manager-options';
import TaskOptions from './interfaces/extractor-task-options';
import Maybe from './interfaces/maybe';
import EventCompleteRatio from './interfaces/event-complete-ratio';

import Extractor from './extractor';
import BookmarksPageManager from './bookmarks-page-manager';

import Exporter from './exporters/exporter';
import JSONExporter from './exporters/json';
import StdOutExporter from './exporters/std-out';

export default class ExtractionTask extends Progressable {
    public static readonly EXPORT_TWEETS: string = 'extractor:export:tweets';
    public static readonly BOOKMARKED_TWEETS_EXTRACTION: string = 'extractor:tweets:extraction';
    public static readonly BOOKMARKED_TWEETS_EXTRACT_COMPLETE: string = 'extractor:tweets:complete';

    public static readonly PROGRESS_EVENTS: string[] = [
        ExtractionTask.BOOKMARKED_TWEETS_EXTRACTION,
        ExtractionTask.BOOKMARKED_TWEETS_EXTRACT_COMPLETE,
        ExtractionTask.EXPORT_TWEETS
    ];

    protected bookmarksPageManager: BookmarksPageManager;
    protected extractor: Extractor;

    protected eventForwarder: Subscription = new Subscription();
    protected tweetStream: Subscription = new Subscription();

    protected tweets: TweetSet = OrderedSet();

    constructor(protected options: TaskOptions) {
        super();

        const {
            credentials,
            chromePath
        } = this.options;

        const pageManagerOptions: PageManagerOptions = {
            credentials,
            chromePath
        }

        this.bookmarksPageManager =
            new BookmarksPageManager(pageManagerOptions);

        this.extractor = new Extractor();

        ExtractionTask.createEventObservable(this.bookmarksPageManager)
            .subscribe((event: ProgressableEvent) => event.handle(this));
    }

    public get numEvents() {
        const pageManagerEvents =
            BookmarksPageManager.PROGRESS_EVENTS.length;

        let taskSpecificEvents =
            ExtractionTask.PROGRESS_EVENTS.length - 1;
        if(this.options.maxLimit !== Number.POSITIVE_INFINITY)
            taskSpecificEvents += this.options.maxLimit;

        const totalEvents =
            pageManagerEvents
            + taskSpecificEvents;

        return totalEvents;
    }

    public run() {
        const bookmarksPage$ = 
            from(this.bookmarksPageManager.open());

        const tweets$ = bookmarksPage$.pipe(
            switchMap((page: Page) => <Observable<TweetSet>> this.extractor.extract(page)),
            reduce((currentTweets: TweetSet, newTweets: TweetSet) => currentTweets.union(newTweets)),
            takeWhile((currentTweets: TweetSet) => currentTweets.size <= this.options.maxLimit)
        );

        const tweetsObserver: Observer<TweetSet> = {
            next: this.onExtractTweets.bind(this),
            error: this.onError.bind(this),
            complete: this.onComplete.bind(this)
        };

        this.tweetStream = tweets$.subscribe(tweetsObserver);
    }

    protected onExtractTweets(tweets: TweetSet) {
        this.tweets = tweets;

        const {
            maxLimit
        } = this.options;
        if(maxLimit === Number.POSITIVE_INFINITY)
            return;

        const numTweetsCollected = this.tweets.size;
        const extractionCompletionRatio: EventCompleteRatio = {
            complete: numTweetsCollected,
            total: maxLimit
        }

        this.emitProgressEvent(
            ExtractionTask.BOOKMARKED_TWEETS_EXTRACTION,
            extractionCompletionRatio
        );
    }

    protected onError(err: Error) {
        this.emitMessageEvent(err.message);

        Maybe.fromValue(err.stack)
            .map(stack => this.emitMessageEvent(stack));

        const errorCallback = this.options.errorCallback;
        return errorCallback(err);
    }

    protected async onComplete() {
        await this.stop();

        const successCallback = this.options.successCallback;
        return successCallback();
    }

    protected static createEventObservable(progressEventEmitter: ProgressEventEmitter) {
        const progressEvents = fromEvent<ProgressEvent>(progressEventEmitter, 'progress');
        const messageEvents = fromEvent<MessageEvent>(progressEventEmitter, 'message');
        const allEvents = merge<ProgressableEvent>(
            progressEvents,
            messageEvents
        );

        return allEvents;
    }

    protected stopForwardingEvents() {
        this.eventForwarder.unsubscribe();
    }

    protected stopStreamingTweets() {
        this.tweetStream.unsubscribe();
    }

    protected emitCompleteEvent() {
        this.emitProgressEvent(
            ExtractionTask.BOOKMARKED_TWEETS_EXTRACT_COMPLETE
        );
    }

    protected async exportTweets(tweets: Tweet[]) {
        try {
            const fileName = this.options.fileName;
            if(fileName) {
                const exporter: Exporter = new JSONExporter(fileName);
                await exporter.export(tweets);
            }

            this.emitProgressEvent(ExtractionTask.EXPORT_TWEETS);
        } catch(err) {
            this.emitMessageEvent('Failed to export tweets to file.');
        }
    }

    protected async printTweetsToStdOut(tweets: Tweet[]) {
        const stdOutExporter = new StdOutExporter();
        await stdOutExporter.export(tweets);
    }

    public async stop() {
        this.stopForwardingEvents();
        this.stopStreamingTweets();
        this.emitCompleteEvent();

        const tweetsArray = ExtractionTask.tweetMapsToTweets(this.tweets, this.options.maxLimit);
        await this.exportTweets(tweetsArray);
        await this.printTweetsToStdOut(tweetsArray);

        await this.bookmarksPageManager.close();
    }

    protected static tweetMapsToTweets(tweets: TweetSet, maxLimit: number) {
        const tweetMapsArray = tweets.toArray()
            .slice(0, maxLimit);

        const tweetsArray =
            tweetMapsArray.map(tweet => tweet.toObject() as unknown as Tweet);
        return tweetsArray;
    }
}
