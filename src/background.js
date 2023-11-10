'use strict';

// Imports & Dependencies
import { createClient } from '@supabase/supabase-js'

// const cheerio = require('cheerio');

const supabase = createClient('https://bjciwqngpahqezdznnrd.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJqY2l3cW5ncGFocWV6ZHpubnJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTg2MDYwNjQsImV4cCI6MjAxNDE4MjA2NH0.UugQMb2VjbExXIf-hOM4OPF-ZTS222YZa8W4nG8ffgk', {
  global: { fetch: fetch.bind(globalThis) }
})

// Constants 
let FBHeaders = {
  'Content-Type': 'application/x-www-form-urlencoded',
};

// Global State Variables
let state = {
  fbProfileToken: undefined,
  fbActorId: undefined
};

// Schedule Chrome Alarms to periodically run the script.
chrome.runtime.onInstalled.addListener(async () => {

  // Clear Any Previous Alarms
  chrome.alarms.clearAll();

  // Schedule Chrome Alarms
  scheduleAlarms();

  enrichProfiles();
});

// On alarms fired, Execute respective code.
chrome.alarms.onAlarm.addListener(async (alarm) => {

  console.log(`Alarm Fired...${alarm.name}`);

  try {
    if (alarm.name === 'messenger' && navigator.onLine) {
      processMessages();
    } if (alarm.name === 'profile_enrichment' && navigator.onLine) {
      enrichProfiles();
    } else if (alarm.name === 'schedule_alarm_times' && navigator.onLine) {
      scheduleAlarms();
    }
  } catch (e) {

  }
});

async function enrichProfiles() {
  let { data: nextProfileForEnrichment, error } = await supabase
    .from('profiles')
    .select("*")
    .neq('enrichment_status', 'HIGH') // Fetch Profiles which do not have "HIGH" enrichment status
    .order('created_at', { ascending: true }) // Order By FIFO
    .limit(1) // Limit to 1 Profile
    .single(); // Format as Single Record

  if (error) {
    if (error.code == "PGRST116") {
      console.log('No profiles to enrich. All profiles are highly enriched.')
    } else {
      console.error('Failed to fetch profiles to enrich', error);
    }
  } else {

    let profile = nextProfileForEnrichment;

    /*
    await fetch(profile.profile_link)
      .then((response) => {
        return response.text();
      })
      .then((data) => {
        console.log(profile.profile_link)
        console.log(data)
        const $ = cheerio.load(data);

        console.log($);

        let intro = $('.x9f619.x1n2onr6.x1ja2u2z.x78zum5.x2lah0s.x1qughib.x1qjc9v5.xozqiw3.x1q0g3np.x1pi30zi.x1swvt13.xyamay9.xykv574.xbmpl8g.x4cne27.xifccgj');

        console.log(intro);

      });*/

  }
}

async function processMessages() {

  await refreshFacebookToken();
  await timeout(50);

  let { data: nextMessageInQueue, error } = await supabase
    .from('message_queue')
    .select("*")
    .neq('status', 'SENT') // Fetch "Not Sent" Messages
    .order('schedule_time', { ascending: true }) // Order By FIFO
    .limit(1) // Limit to 1 Message
    .single(); // Format as Single Record

  if (error) {
    if (error.code == "PGRST116") {
      console.log('No message sent. Queue is empty.')
    } else {
      console.error('Failed to fetch message queue', error);
    }
  } else {

    console.log(nextMessageInQueue)

    await sendFacebookMessage({
      msg: nextMessageInQueue.message_text,
      user: nextMessageInQueue.user_id,
    });

    const { error } = await supabase
      .from('message_queue')
      .update({ status: 'SENT' })
      .eq('id', nextMessageInQueue.id)

    if (error) {
      console.error('Failed to update sent message status in database', error)
    }
  }

  return;

  await getReachOWLCookie();
  await timeout(50);
  await fetchReachOwlUser();
  let queues = await getRecords(`queues?platform=${platform}`);
  if (queues.data.length) {
    let campaigns = await getRecords('campaigns?filter=executor');
    let campaignKeyVal = {};
    for (let campaign of campaigns) {
      campaignKeyVal[campaign.id] = campaign;
    }
    let queueItems = queues.data.filter((qItem) => {
      return (Date.now() >= (qItem.scheduled_at * 1000));
    });
    for (let i = 0; i < queueItems.length; i++) {
      const queueItem = queueItems[i];
      let targetInstagramThread = null;
      if (campaignKeyVal[queueItem.campaign_id].platform === 'instagram') {
        await getInstagramCookie();
        try {
          const instaUserData = await fetchInstagramUser(queueItem.audience.member_id);
          const targetProfile = instaUserData.data.user.id;
          targetInstagramThread = await fetchInstagramThread(targetProfile);
        } catch (e) {
          addFriendRequests([{
            'id': queueItem.audience.id,
            'campaign_id': queueItem.campaign_id,
            'deleted_reason': 'ReachOwl ignored this recipient because thread cannot be opened.',
            'deleted_at': Date.now()
          }]);
          break;
        }
      } if (campaignKeyVal[queueItem.campaign_id].platform === 'facebook') {
        await fetchFBToken();
        await timeout(50);
      }
      //Check for message replied
      if (queueItem.step !== 0) {
        const replied = await checkMessagedReplied(queueItem.audience_id);
        if (replied) {
          continue;
        }
      } else if (campaignKeyVal[queueItem.campaign_id].new_conversation === 1) {
        let conversationExists = false;
        if (targetInstagramThread && targetInstagramThread.items.length) {
          conversationExists = true;
        } else if (campaignKeyVal[queueItem.campaign_id].platform === 'facebook') {
          conversationExists = await checkCoversationExists(queueItem.audience);
        }
        if (conversationExists) {
          addFriendRequests([{
            'id': queueItem.audience.id,
            'campaign_id': queueItem.campaign_id,
            'deleted_reason': 'ReachOwl ignored this recipient because conversation already exist.',
            'deleted_at': Date.now()
          }]);
          continue;
        }
      }
      let messageObj = {
        msg: queueItem.user_message,
        user: queueItem.audience.member_id
      };
      if (campaignKeyVal[queueItem.campaign_id].platform === 'facebook') {
        await sendFacebookMessage(messageObj);
        await timeout(100);
        let data = await fetchThreadHistory(queueItem.audience.member_id);
        if (data.data?.message_thread?.last_message?.nodes[0]) {
          const lastMessage = data.data.message_thread.last_message.nodes[0];
          if (lastMessage.message_sender.messaging_actor.id == state.fbActorId) {
            await editQueue('queues', { 'ids': [queueItem.id], 'sent': 1, 'sent_at': Date.now() });
          }
        } else {
          addFriendRequests([{
            'id': queueItem.audience.id,
            'campaign_id': queueItem.campaign_id,
            'deleted_reason': 'Your message can\'t be delivered. Person you are trying to send message have blocked the incoming messages.',
            'deleted_at': Date.now()
          }]);
        }
      } else if (targetInstagramThread && campaignKeyVal[queueItem.campaign_id].platform === 'instagram') {
        sendInstagramDM(targetInstagramThread.thread_id, queueItem.user_message).then((resp) => {
          if (resp.status == 'ok') {
            editQueue('queues', { 'ids': [queueItem.id], 'sent': 1, 'sent_at': Date.now() });
          } else {
            throw new Error('Unable to send message');
          }
        }).catch((e) => {
          addFriendRequests([{
            'id': queueItem.audience.id,
            'campaign_id': queueItem.campaign_id,
            'deleted_reason': 'Your message can\'t be delivered. You can send more messages after your invitation to chat is accepted.',
            'deleted_at': Date.now()
          }]);
        });
      }
      break;
    }
  }

}

async function sendFacebookMessage(obj) {
  try {
    let mId = Math.floor(Math.random() * 999999999);
    const resp = await fetch(`https://www.facebook.com/messaging/send/`, {
      method: 'POST',
      headers: FBHeaders,
      body: new URLSearchParams({
        fb_dtsg: state.fbProfileToken,
        action_type: "ma-type:user-generated-message",
        client: "mercury",
        ephemeral_ttl_mode: 0,
        has_attachment: false,
        message_id: mId,
        offline_threading_id: mId,
        source: "source:titan:web",
        timestamp: Date.now(),
        ...(obj.msg) ? ({ body: obj.msg }) : "",
        ...(obj.thread) ? ({ thread_fbid: obj.thread }) : "",
        ...(obj.user) ? ({ other_user_fbid: obj.user }) : "",
      })
    }
    );
    return;
  } catch (e) {
    console.error("Failed to send Facebook message.", e);
  }
}

async function refreshFacebookToken() {
  console.log('Refreshing Facebook Token...');
  await fetch('https://www.facebook.com/settings')
    .then((response) => {
      return response.text();
    })
    .then((data) => {
      state.fbProfileToken = data.split('{"token":"')[1].split('"')[0];
      state.fbActorId = data.split('{"actorID":"')[1].split('"')[0];

      console.log(`Facebook Token Refreshed\nProfile Token: ${state.fbProfileToken}\nMessage Actor ID:${state.fbActorId}`);
    });
}

// Goes through all Alarms and ensures each 
// Alarm is setup correctly.
async function scheduleAlarms() {

  await timeout(50); // Wait 50ms

  console.log('Scheduling Alarms...');

  // Ensure Messenger alarm is setup.
  // After 5 minutes, then every 10 minutes.
  chrome.alarms.get('messenger', (alarm) => {
    if (alarm === undefined) {
      chrome.alarms.create(
        "messenger",
        { delayInMinutes: 5, periodInMinutes: 10 },
      );
    }
  });

  // Ensure Profile Enrichment alarm is setup.
  // After 3 minutes, then every 5 minutes.
  chrome.alarms.get('profile_enrichment', (alarm) => {
    if (alarm === undefined) {
      chrome.alarms.create(
        "profile_enrichment",
        { delayInMinutes: 3, periodInMinutes: 5 },
      );
    }
  });

  // Ensure Alarm Re-Schedule alarm is setup.
  // Every 3 minutes.
  chrome.alarms.get('schedule_alarm_times', (alarm) => {
    if (alarm === undefined) {
      chrome.alarms.create("schedule_alarm_times", { periodInMinutes: 3 });
    }
  });
}

// Simple Wait Function in Milliseconds
async function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}