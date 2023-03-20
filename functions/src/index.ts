import { https, logger, config, Response, Request } from 'firebase-functions';
import * as admin from 'firebase-admin';
import Github, { PullRequestFiles } from './github';
import { PullRequestLabeledEvent } from '@octokit/webhooks-types';
import { Configuration, OpenAIApi } from 'openai';
import { Octokit } from 'octokit';
import { allowCors } from './helper';
import Stripe from 'stripe';

admin.initializeApp();

const apiKey = config().openai.api_key;
const configuration = new Configuration({
  apiKey,
});
const OpenAI = new OpenAIApi(configuration);
const stripeKey = config().stripe.api_key;
const stripeEndpointSecret = config().stripe.webhook_secret;
const stripe = new Stripe(stripeKey, {
  apiVersion: '2022-11-15',
});

export const stripeWebhook = https.onRequest(async (request, response) => {
  const sig = request.header('stripe-signature') || '';

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      request.rawBody,
      sig,
      stripeEndpointSecret,
    );
  } catch (err) {
    const error = err as Error;
    logger.error(error);
    response.status(400).send(`Webhook Error: ${error.message}`);
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const subscription = session.subscription as string;
    const customer = session.customer as string;

    try {
      const [subscriptionData, customerData] = await Promise.all([
        stripe.subscriptions.retrieve(subscription),
        stripe.customers.retrieve(customer),
      ]);
      const email = customerData.id;
      const subItem = subscriptionData.items.data[0];
      // Update the User document in Firestore with the new plan information
      // Find the user with the email and update the plan
      const query = await admin
        .firestore()
        .collection('users')
        .where('email', '==', email)
        .limit(1)
        .get();
      const user = query.docs[0];
      if (
        session.payment_status === 'paid' ||
        session.payment_status === 'no_payment_required'
      ) {
        const getLimits = () => {
          const userDoc = user.data();
          const usage = userDoc.usage || {};
          if (userDoc.plan === 'starter') {
            return {
              ...usage,
              repos_limit: 4,
              loc_limit: 100000,
            };
          } else if (userDoc.plan === 'pro') {
            return {
              ...usage,
              repos_limit: 30,
              loc_limit: 800000,
            };
          } else {
            return {
              ...usage,
              repos_limit: 1,
              loc_limit: 25000,
            };
          }
        };
        await user.ref.update({
          usage: getLimits(),
          stripe: {
            subscription: {
              id: subscription,
              active: subscriptionData.status === 'active',
              default_source: subscriptionData.default_source,
              price_id: subItem.price.id,
              price_key: subItem.price.nickname,
              product_id: subItem.price.product,
            },
            customer: {
              id: customer,
            },
          },
        });
      }

      logger.info(
        `Subscription created for ${email} on ${subItem.price.nickname}`,
      );
    } catch (err) {
      const error = err as Error;
      logger.error(error);
      response.status(400).send(`Failed to perform logic: ${error.message}`);
      return;
    }
  }

  response.send();
});

export const githubWebhook = https.onRequest(async (request, response) => {
  const isPreflight = allowCors(request, response);
  if (isPreflight) return;

  const body = request.body;
  logger.log({ action: body.action });

  let repoName = '';
  let repoOwner = '';
  let pullNumber = 0;
  let octokit: Octokit | null = null;
  let content: PullRequestFiles = [];

  if (body.action) {
    const fetched = await fetchDiff(request, response);
    if (!fetched) {
      return;
    }
    const success = await validateRepoCountLimit(
      fetched.repoName,
      fetched.repoOwner,
      fetched.pullNumber,
      fetched.octokit,
    );
    if (!success) {
      response.status(400).send({
        message:
          'Failed to validate subscription level. Please contact support.',
      });
    }
    content = fetched.data;
    repoName = fetched.repoName;
    repoOwner = fetched.repoOwner;
    pullNumber = fetched.pullNumber;
    octokit = fetched.octokit;
  } else if (body.diff_body) {
    const validated = await validateDiffFormat(body.diff_body);
    if (!validated) {
      response.status(400).send({
        message:
          'The diff provided is not valid. Did you run the command properly?',
      });
      return;
    }
    content = JSON.parse(body.diff_body);
  } else {
    response.status(400).send({
      message: 'No sources provided to analyze Github files.',
    });
    return;
  }

  const filestoAnalyze = Github.filterOutFiltersToAnalyze(content);
  const filenames = filestoAnalyze.map((file) => file.filename);
  const chunks = Github.breakFilesIntoChunks(filestoAnalyze);
  logger.info(`Number of chunks to send: ${chunks.length}`);
  logger.info('files to process:', filenames);

  /*
  const totalChanges = filestoAnalyze.reduce(
    (acc, file) => acc + file.changes,
    0,
  );

  if (!body.diff_body) {
    const locLimit = await validateCodeLimit(
      totalChanges,
      repoName,
      repoOwner,
      pullNumber,
      octokit,
    );

    if (!locLimit) {
      response.status(400).send({
        message:
          'You have exceeded your lines of code monthly limit. Please upgrade your subscription.',
      });
      return;
    }
  }*/

  let responses = await Promise.all(
    chunks.map(async (chunk) => {
      const combined = JSON.stringify(chunk);
      if (combined.length < 100) {
        return '';
      }

      const gpt = await getSummaryForPR(combined);
      const message = gpt?.choices[0].message?.content;
      return message || '';
    }),
  );
  responses = responses.filter(Boolean);

  const prefix = [
    '## :robot: Explain this PR :robot:',
    'Here is a summary of what I noticed. I am a bot in Beta, so I might be wrong. :smiling_face_with_tear:',
    'Please [share your feedback](https://tally.so/r/3jZG9E) with me. :heart:',
  ];
  if (responses.length === 0) {
    logger.error('No responses from GPT');
    responses = [
      'No changes to analyze. Something likely went wrong. :thinking_face: We will look into it!',
      'Sometimes re-running the analysis helps with timeout issues. :shrug:',
    ];
  }

  const comment = [...prefix, ...responses].join('\n');

  try {
    if (octokit) {
      logger.info('Adding a comment to the PR..');
      await octokit.rest.issues.createComment({
        owner: repoOwner,
        repo: repoName,
        issue_number: pullNumber,
        body: comment,
      });
      logger.info('Comment added to the PR:', { comment });
    }
  } catch (e: any) {
    const error = e?.response?.data || e;
    logger.error('Failed to create comment', error);
  }

  response.send({
    comment,
  });
});

async function fetchDiff(request: Request, response: Response) {
  const body = request.body;
  const signature = request.header('x-hub-signature-256');
  const signatureGood = Github.verifySignature(
    JSON.stringify(body),
    signature || '',
  );

  if (!signatureGood) {
    response.status(403).send({
      message: 'Forbidden. Signature verification failed.',
    });
    return;
  }

  let installationId = 0;
  let repoName = '';
  let repoOwner = '';
  let pullNumber = 0;

  if (body.action === 'labeled') {
    const payload = body as PullRequestLabeledEvent;
    const label = payload.label.name.toLowerCase();
    if (label !== 'explainthispr') {
      response.send({
        message: 'Nothing for me to do.',
      });
      return;
    }

    installationId = payload.installation?.id || 0;
    repoName = payload.repository.name;
    repoOwner = payload.repository.owner.login;
    pullNumber = payload.pull_request.number;
    /*} else if (
    body.action === 'added' &&
    (body.repositories_added?.length || 0) > 0
  ) {
    logger.info('repo added. Saving to db..');
    const newRepoName = body.repositories_added[0].full_name;
    const success = await repoAdded(body.sender.id, newRepoName);
    const message = !success
      ? 'Failed to validate subscription level. Please contact support.'
      : 'Successfully added the repository to your account.';
    const status = !success ? 400 : 200;
    response.status(status).send({
      message,
    });
    return;
  } else if (
    body.action === 'removed' &&
    (body.repositories_removed?.length || 0) > 0
  ) {
    logger.info('repo removed. Updating the db..');
    const deletedRepoName = body.repositories_removed[0].full_name;
    await repoRemoved(body.sender.id, deletedRepoName);
    const message = 'Successfully removed the repository from your account.';
    response.send({
      message,
    });
    return;*/
  } else {
    logger.info('Bad action request. Ignoring..');
    response.send({
      message: 'Nothing for me to do.',
    });
    return;
  }

  const octokit = await Github.createInstance(installationId);
  const data = await octokit.rest.pulls.listFiles({
    owner: repoOwner,
    repo: repoName,
    pull_number: pullNumber,
  });
  return {
    data: data.data,
    pullNumber,
    octokit,
    repoName,
    repoOwner,
  };
}

/**
 * Validate if the content is in the correct format of PullRequestFiles
 * @param content The content to validate
 * @returns
 */
async function validateDiffFormat(content: string) {
  try {
    const parsed = JSON.parse(content) as PullRequestFiles;
    const first = parsed[0];
    if (!first || !first.filename || !first.status || !first.changes) {
      return false;
    }

    if (parsed.length === 0) {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

async function getSummaryForPR(content: string) {
  try {
    const prompt = `
    You are an assistant designed to help developer teams review the PRs. Every time a PR is opened, I will send you a code file with the before and the after.
    I want you to compare the two and give me an overview of the things that were changed in the code in a bullet list format.
    I want your comments to be focused on architectural changes that affect the app.
    The format of your response should be in Markdown. Here is an example of a response.
    Limit how many import statements you have per file to 3 max.
    Please do not repeat yourself. If you already mention a technology like \`useFonts\` do not mention it again for that file.
    Please use the full filename. For example, \`src/components/Button.tsx\` is better than \`Button.tsx\`.
    Please be concise and do not talk repeatedly about the same change. If you have already mentioned how PDF data generation works for example, do not discuss again it.
    Only focus on the most impactful functional changes. The maximum is 4 bullet points. For each additional bullet point, divide the total \`patch\` length by 1500 to determine how many more bullet points you can add for this file.
    Here is an example of a response:
    ## src/App.tsx
      - Moved the routing logic to a standalone \`Router\` component
      - Setup a listener for the AuthState of the user and update the Redux store with the current user

    `;
    logger.info('GPT Request: ', { content });
    const { data } = await OpenAI.createChatCompletion({
      model: 'gpt-3.5-turbo',
      max_tokens: 400,
      temperature: 0.3,
      frequency_penalty: 0.2,
      presence_penalty: 0.3,
      top_p: 1,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content },
      ],
    });
    logger.info('GPT Response: ', {
      usage: data.usage,
      content: data.choices[0],
    });
    return data;
  } catch (err: any) {
    const error = err?.response?.data || err;
    logger.error('Failed to make GPT request', error);
    return null;
  }
}

async function validateRepoCountLimit(
  repoName: string,
  repoOwner: string,
  pullNumber: number,
  octokit: Octokit,
) {
  /*
  Find the user who owns the repo
  Count the length of subs[] they have vs. the limit
  If over, throw an error to end the request
*/
  try {
    const query = await admin
      .firestore()
      .collection('Users')
      .where(
        'repos',
        'array-contains',
        `${repoOwner}/${repoName}`.toLowerCase(),
      )
      .get();
    if (query.empty) {
      return false;
    }
    const user = query.docs[0].data();
    const { repos_limit } = user.usage;

    if (user.repos.length > repos_limit) {
      await octokit.rest.issues.createComment({
        owner: repoOwner,
        repo: repoName,
        issue_number: pullNumber,
        body: [
          `You have reached the limit of ${repos_limit} repos.`,
          `Please remove a repo from your account to resume the service.`,
        ].join('\n'),
      });
      return false;
    }
    return true;
  } catch (e) {
    logger.error('Failed to validate subscription level', e);
    return false;
  }
}

async function validateCodeLimit(
  LOC: number,
  repoName: string,
  repoOwner: string,
  pullNumber: number,
  octokit: Octokit | null,
) {
  /*
  Find the user who owns the repo
  Count the length of subs[] they have vs. the limit
  If over, throw an error to end the request
*/
  try {
    const query = await admin
      .firestore()
      .collection('Users')
      .where(
        'repos',
        'array-contains',
        `${repoOwner}/${repoName}`.toLowerCase(),
      )
      .get();
    if (query.empty) {
      return false;
    }
    const user = query.docs[0].data();
    const { loc_limit } = user.usage;

    if (LOC >= loc_limit) {
      await octokit?.rest.issues.createComment({
        owner: repoOwner,
        repo: repoName,
        issue_number: pullNumber,
        body: [
          `You have reached the limit of ${loc_limit} lines of code for this month.`,
          `Wait until the next month to resume the service or upgrade your subscription.`,
        ].join('\n'),
      });
      return false;
    }
    return true;
  } catch (e) {
    logger.error('Failed to validate subscription level', e);
    return false;
  }
}

if (10 < 1) {
  repoAdded('123', 'test');
  repoRemoved('123', 'test');
  validateCodeLimit(100, 'test', 'test', 1, null);
}

/**
 * Add the repo to the list of repos for the user if within limits
 */
async function repoAdded(githubId: string, repoName: string) {
  try {
    // Find user by githubId
    const query = await admin
      .firestore()
      .collection('Users')
      .where('githubId', '==', githubId)
      .get();
    if (query.empty) {
      return false;
    }
    const user = query.docs[0].data();
    const { repos_limit } = user.usage;
    if (user.repos.length >= repos_limit) {
      return false;
    }

    // Add repo to user
    await admin
      .firestore()
      .collection('Users')
      .doc(user.id)
      .update({
        repos: admin.firestore.FieldValue.arrayUnion(repoName),
      });
    return true;
  } catch (e) {
    logger.error('Failed to add repo to user', e);
    return false;
  }
}

/**
 * Remove a repo from the list of repos for a user
 */
async function repoRemoved(githubId: string, repoName: string) {
  try {
    // Find user by githubId
    const query = await admin
      .firestore()
      .collection('Users')
      .where('githubId', '==', githubId)
      .get();
    if (query.empty) {
      return;
    }
    const user = query.docs[0].data();

    // Remove repo to user
    await admin
      .firestore()
      .collection('Users')
      .doc(user.id)
      .update({
        repos: admin.firestore.FieldValue.arrayRemove(repoName),
      });
  } catch (e) {
    logger.error('Failed to remove repo to user', e);
  }
}
/*
When a user is created, save their limits on their account
When a new repo is connected/removed to the app, find the user it belongs to and update their limits
*/
