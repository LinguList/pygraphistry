import logger from '../../../shared/logger.js';
import conf from '../../../server/config.js';
import { DataFrame, Row } from 'dataframe-js';

import { Observable } from 'rxjs';
import splunkjs from 'splunk-sdk';
import objectHash from 'object-hash';
import VError from 'verror';


const SPLUNK_HOST = conf.get('splunk.host');
const SPLUNK_USER = conf.get('splunk.user');
const SPLUNK_PWD = conf.get('splunk.key');

const metadata = { splunkHostName: SPLUNK_HOST, splunkUser: SPLUNK_USER };
const log = logger.createLogger('pivot-app', __filename).child(metadata);

const service = new splunkjs.Service({
    host: SPLUNK_HOST,
    username: SPLUNK_USER,
    password: SPLUNK_PWD
});

const splunkLogin = Observable.bindNodeCallback(service.login.bind(service));
const splunkGetJob = Observable.bindNodeCallback(service.getJob.bind(service));
const splunkSearch = Observable.bindNodeCallback(service.search.bind(service));

const searchParamDefaults = {
    timeout: Math.max(0, conf.get('splunk.jobCacheTimeout')),
    exec_mode: 'blocking',
    earliest_time: '-7d',
}


export const SplunkConnector = {
    id:'splunk-connector',
    name : 'Splunk',
    lastUpdated : new Date().toLocaleString(),
    status: {
        level: 'info',
        message: null
    },

    search : function search(query, searchParamOverrides = {}) {
        // Generate a hash for the query so we can look it up in splunk
        const hash = conf.get('splunk.jobCacheTimeout') > 0 ? objectHash.MD5({q: query, p: searchParamOverrides})
                                                            : Date.now();
        const jobId = `pivot-app::${hash}`;

        // Set the splunk search parameters
        const searchParams = {
            ...searchParamDefaults,
            ...searchParamOverrides,
            id: jobId,
        };

        // Used to indentifity logs
        const searchInfo = { query, searchParams };
        log.debug(searchInfo, 'Tentatively fetching cached results for splunk job: "%s"', jobId);

        // TODO Add this as part of splunk connector
        return splunkGetJob(jobId)
            .catch(() => {
                log.debug('No job was found, creating new search job');
                const results = splunkSearch( query, searchParams );
                return results.switchMap(job => {
                    const splunkFetchJob = Observable.bindNodeCallback(job.fetch.bind(job));
                    return splunkFetchJob();
                });
            })
            .catch(({data}) => Observable.throw(new VError({
                name: 'SplunkParseError',
                info: searchInfo
            }, data.messages[0].text)))
            .switchMap(job => {
                const props = job.properties();
                log.debug({
                    sid: job.sid,
                    eventCount: props.eventCount,
                    resultCount: props.resultCount,
                    runDuration: props.runDuration,
                    ttl: props.ttl
                }, 'Search job properties');

                const getResults = Observable.bindNodeCallback(job.results.bind(job),
                    function(results) {
                        return ({results, job});
                    });
                const jobResults = getResults({count: job.properties().resultCount, output_mode: 'json_cols'}).catch(
                    (e) => {
                        return Observable.throw(new Error(
                            `${e.data.messages[0].text} ========>  Splunk Query: ${query}`));
                        }
                );
                return jobResults;
            }).map(
                function({results, job}) {
                    const columns = {};
                    results.fields.map((field, i) => {
                        columns[field] = results.columns[i];
                    });
                    const df = new DataFrame(columns, results.feilds);
                    const events = df.toCollection();
                    const resultCount = job.properties().resultCount;
                    return { resultCount, events, df, searchId:job.sid };
                }
            );
    },

    login: function login() {
        return splunkLogin()
            .do(log.info('Health checks passed for splunk connnector'))
            .map(() => 'Health checks passed')
            .catch(({error, status}) => {
                if (error) {
                    return Observable.throw(
                        new VError({
                            name: 'ConnectionError',
                            cause: error,
                            info: {
                                splunkAddress: error.address,
                                splunkPort: error.port,
                                code: error.code,
                            }
                        }, 'Failed to connect to splunk instance at "%s:%d"', error.address, error.port)
                    );
                } else if (status === 401) {
                    return Observable.throw(
                        new VError({
                            name: 'UnauthorizedSplunkLogin',
                        }, 'Splunk Credentials are invalid')
                    );
                } else {
                    return Observable.throw(
                        new VError({
                            name: 'UnhandledStatus',
                        }, 'Uknown response')
                    );
                }
            });
    },

}
